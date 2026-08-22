#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# FAB 生产日常交接系统 — Oracle Cloud Always Free 一键部署脚本
# 目标系统：Ubuntu 22.04 / 24.04 LTS (ARM64)
#
# 功能：
#   1. 安装 Node.js 20 LTS (NodeSource)
#   2. 安装 better-sqlite3 需要的编译工具链 (arm64 需源码编译，必须)
#   3. 拉取项目源码并安装 npm 依赖
#   4. 用 pm2 托管 node server.js（开机自启 + 崩溃自动重启 + 日志）
#   5. 用 nginx 反向代理（端口 80），可选项：配置自定义域名
#
# 用法：
#   sudo bash deploy.sh                                  # 默认 HTTP :80
#   sudo DOMAIN=example.com bash deploy.sh               # 同时配置域名+Let's Encrypt
#   sudo AUTO_SSL=false bash deploy.sh                   # 用外部反代/想手动配证书
#
# 提示：先创建好 VM 并确定公网 IP 后，SSH 登录再执行本脚本。
###############################################################################

# ─── 配置区（可按需修改）────────────────────────────────────────
APP_DIR="${APP_DIR:-/root/fab-handover-system}"          # 项目部署目录
REPO_URL="${REPO_URL:-https://github.com/tianyingfei1995/fab-handover-system.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR=20                                            # Node 主版本
PORT_APP="${PORT:-3000}"                                 # 应用内部端口（默认 3000）
DOMAIN="${DOMAIN:-}"                                     # 若设置则配置 nginx+HTTPS
AUTO_SSL="${AUTO_SSL:-false}"                            # 是否自动申请 Let's Encrypt
ADMIN_USER="root"                                        # 部署运行用户

# ─── 颜色输出 ────────────────────────────────────────────────
c_green='\033[0;32m'; c_yellow='\033[1;33m'; c_red='\033[0;31m'; c_reset='\033[0m'
log(){ echo -e "${c_green}[部署]${c_reset} $*"; }
warn(){ echo -e "${c_yellow}[警告]${c_reset} $*"; }
err(){ echo -e "${c_red}[错误]${c_reset} $*" >&2; }

# 检查是否为 root
if [ "$(id -u)" -ne 0 ]; then err "请用 root 运行：sudo bash deploy.sh"; exit 1; fi

# ─── 1. 系统更新 + 安装基础工具 ───────────────────────────────
log "系统更新并安装基础工具..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git nginx ufw gnupg build-essential \
                   python3 python3-pip make g++ libsqlite3-dev

# ─── 2. 安装 Node.js 20 LTS ──────────────────────────────────
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "v$NODE_MAJOR"; then
  log "安装 Node.js $NODE_MAJOR LTS..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
log "Node: $(node -v)  npm: $(npm -v)"

# ─── 3. 拉取/更新项目源码 ─────────────────────────────────────
log "获取项目源码到 $APP_DIR ..."
if [ -d "$APP_DIR/.git" ]; then
  warn "目录已存在，执行 git pull 更新代码。"
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout -f "$BRANCH"
  git -C "$APP_DIR" pull origin "$BRANCH"
else
  mkdir -p "$APP_DIR"
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# ─── 4. 安装 npm 依赖（arm64 需编译原生模块）────────────────────
log "安装 npm 依赖（copy node_modules 模式，避免污染源码目录）..."
cd "$APP_DIR"
# 使用 -g 之外的本地安装。为便于 pm2 使用，直接本地安装到项目。
npm install --no-audit --no-fund
# 若安装过程中 better-sqlite3 因网络/工具链失败，给出手动重试提示
if ! node -e "require('better-sqlite3'); console.log('better-sqlite3 加载成功')" 2>/dev/null; then
  warn "better-sqlite3 加载失败，尝试强制源码编译..."
  cd "$APP_DIR"
  npm rebuild better-sqlite3
  node -e "require('better-sqlite3'); console.log('better-sqlite3 重编译成功')" \
    || { err "better-sqlite3 初始化失败，请安装 build-essential 后重试 npm rebuild better-sqlite3"; exit 1; }
fi

# 创建运行时数据/上传目录（server.js 会 mkdir，这里确保权限正确）
mkdir -p "$APP_DIR/data" "$APP_DIR/public/uploads"
chown -R "$ADMIN_USER:$ADMIN_USER" "$APP_DIR" || true

# ─── 5. 安装 pm2 并启动应用 ──────────────────────────────────
log "安装 pm2 进程守护..."
npm install -g pm2

log "使用 pm2 启动应用..."
cd "$APP_DIR"
# 设置生产环境变量（PORT 由应用读取）
export NODE_ENV=production
# 若之前已有进程，先停止旧实例
pm2 delete fab-handover 2>/dev/null || true
pm2 start server.js --name fab-handover \
  --env production \
  --time
pm2 save

# 设置 pm2 开机自启（输出系统特定的启动脚本）
log "配置 pm2 开机自启..."
pm2 startup systemd -u "$ADMIN_USER" --hp "/root" 2>/dev/null || pm2 startup 2>/dev/null || true

# ─── 6. 配置 nginx 反向代理（HTTP :80 或 HTTPS）──────────────
log "配置 nginx 反向代理..."
NGINX_CONF="/etc/nginx/sites-available/fab-handover"

UPSTREAM="127.0.0.1:${PORT_APP}"
if [ -n "$DOMAIN" ]; then
  SERVER_NAME="$DOMAIN"
else
  # 无域名则绑定到本机公网 IP（自动探测）
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  SERVER_NAME="${SERVER_IP:-_}"
fi

cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name $SERVER_NAME;

    # 上传文件大小上限（图片），按需调整
    client_max_body_size 50m;

    location / {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/fab-handover
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable nginx --now 2>/dev/null || true
systemctl reload nginx 2>/dev/null || true

# ─── 7. 配置防火墙（可选，若启用了 ufw）───────────────────────
log "配置 UFW 防火墙规则..."
ufw allow OpenSSH 2>/dev/null || true
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true
# 应用端口默认经 nginx 反代无需对公网开放；如走直连可放开：
# ufw allow ${PORT_APP}/tcp 2>/dev/null || true
ufw --force enable 2>/dev/null || true

# ─── 8. 若指定域名且开启 AUTO_SSL，用 certbot 自动申请证书 ──
if [ -n "$DOMAIN" ] && [ "$AUTO_SSL" = "true" ]; then
  log "为 $DOMAIN 申请 Let's Encrypt 证书..."
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || warn "证书申请失败，请手动检查域名解析"
fi

# ─── 9. 完成 ────────────────────────────────────────────────
log ""
log "======================================================================"
if [ -n "$DOMAIN" ]; then
  URL="https://$DOMAIN"
elif [ -n "${SERVER_IP:-}" ]; then
  URL="http://$SERVER_IP"
else
  URL="<服务器公网IP>"
fi
log "  部署完成！"
log "  访问地址: $URL"
log "  默认管理员: admin / admin123  （建议登录后立即修改）"
log "  进程管理: pm2 list | pm2 logs fab-handover | pm2 restart fab-handover"
log "======================================================================"