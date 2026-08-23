#!/usr/bin/env bash
###############################################################################
# FAB 生产日常交接系统 — 腾讯云 CVM 一键部署脚本
# 目标系统：Ubuntu 20.04/22.04/24.04 · Debian 11/12 · CentOS 7/8 · TencentOS
#           （腾讯云 CentOS7.9/TencentOS 与 Ubuntu 均适用，自动识别包管理器）
#
# 模式 A [推荐·含依赖整包]：源码目录已带 node_modules + data/fab.db 整包上传，
#                           本脚本跳过网络拉取，直接部署（离线友好）。
# 模式 B  [线上拉取]     ：服务器可联网访问 GitHub，用 git 拉取源码 + npm install。
#
# 用法：
#   sudo bash deploy-tencent.sh                          # 默认 HTTP :80
#   sudo bash deploy-tencent.sh --mode oneline           # 显式走线上拉取
#   sudo DOMAIN=example.com AUTO_SSL=true bash deploy-tencent.sh
#
# 前置：先登录腾讯云控制台，将「安全组」放行 80/443 端口（公网访问必须）。
###############################################################################
set -euo pipefail

# ─── 可配置参数 ─────────────────────────────────────────────
APP_DIR="${APP_DIR:-/root/fab-handover-system}"        # 部署目录（改这里=改整包上传目标）
REPO_URL="${REPO_URL:-https://github.com/tianyingfei1995/fab-handover-system.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-20}"
PORT_APP="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
AUTO_SSL="${AUTO_SSL:-false}"
MODE_AUTO="auto"; MODE="${1:-$MODE_AUTO}"               # auto|online
RUN_USER="${RUN_USER:-root}"

c_green='\033[0;32m'; c_yellow='\033[1;33m'; c_red='\033[0;31m'; c_reset='\033[0m'
log(){ echo -e "${c_green}[部署]${c_reset} $*"; }
warn(){ echo -e "${c_yellow}[警告]${c_reset} $*"; }
err(){ echo -e "${c_red}[错误]${c_reset} $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then err "请用 root 运行：sudo bash deploy-tencent.sh"; exit 1; fi

# ─── 探测系统 / 包管理器 ────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt"; log "检测到 Debian/Ubuntu/TencentOS-apt 系系统"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"; log "检测到 CentOS/RHEL/TencentOS-yum 系系统"
else
  err "无法识别的包管理器，请更换为 Ubuntu 或 CentOS 镜像后重试"; exit 1
fi

pkg_install(){
  local pkgs="$*"
  export DEBIAN_FRONTEND=noninteractive
  if [ "$PKG" = "apt" ]; then
    apt-get update -y
    apt-get install -y $pkgs
  else
    yum install -y $pkgs
  fi
}

# ─── 0. 预部署清理：先关闭腾讯云原本在线的项目 ───────────────
log "预部署清理：关闭原本在线的旧项目，释放 3000/80 端口..."
# 0.1 停止并删除旧的 pm2 进程（若旧项目用 pm2 托管）
if command -v pm2 >/dev/null 2>&1; then
  log "停止旧的 pm2 进程..."
  pm2 delete fab-handover 2>/dev/null && log "已停止 pm2 进程 fab-handover" || \
    warn "pm2 无 fab-handover 进程（可能与旧项目名称不同，跳过）"
  pm2 kill 2>/dev/null || true
fi

# 0.2 停止占用 3000 端口的 Node 进程（通用清理，避免端口冲突）
PORT_PID=$(lsof -t -i tcp:"$PORT_APP" 2>/dev/null || ss -lptn 2>/dev/null | awk -v p=":$PORT_APP" '$4 ~ p {gsub(/.*pid=/,"",$6); print $6}' | head -1)
if [ -n "$PORT_PID" ]; then
  warn "端口 $PORT_APP 被 PID $PORT_PID 占用，正在停止该进程..."
  kill -TERM "$PORT_PID" 2>/dev/null || kill -9 "$PORT_PID" 2>/dev/null || true
  sleep 1
fi

# 0.3 若旧项目通过 systemd 托管（03-systemd 方式），一并停止并禁用
if [ -f /etc/systemd/system/fab-handover.service ]; then
  log "检测到旧 systemd 服务，正在停止并禁用..."
  systemctl stop fab-handover 2>/dev/null || true
  systemctl disable fab-handover 2>/dev/null || true
fi

log "旧项目清理完成，开始全新部署。"

# ─── 1. 系统基础依赖 ────────────────────────────────────────
log "安装系统基础依赖..."
if [ "$PKG" = "apt" ]; then
  pkg_install curl ca-certificates git nginx python3 make g++ \
             build-essential libsqlite3-dev >/dev/null 2>&1 || true
else
  pkg_install curl git nginx gcc gcc-c++ make python3 \
             openssl-devel sqlite-devel >/dev/null 2>&1 || true
fi
pkg_install unzip >/dev/null 2>&1 || true

# ─── 2. 安装 Node.js（离线模式若已装则跳过）──────────────────
if command -v node >/dev/null 2>&1 && node -v | grep -q "v$NODE_MAJOR"; then
  log "Node.js 已存在: $(node -v)"
else
  log "安装 Node.js $NODE_MAJOR LTS..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - 2>/dev/null || \
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - 2>/dev/null || true
  if [ "$PKG" = "apt" ]; then apt-get install -y nodejs || true
  else yum install -y nodejs || true; fi
  if ! command -v node >/dev/null 2>&1; then
    warn "NodeSource 安装失败，回退到官方二进制安装..."
    ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH=x64; [ "$ARCH" = "aarch64" ] && ARCH=arm64
    VER="v$(curl -s https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/ 2>/dev/null | grep -oP 'v[\d.]+' | head -1)"
    [ -z "$VER" ] && VER="v${NODE_MAJOR}.19.3"
    curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-linux-$ARCH.tar.xz" -o /tmp/node.tar.xz \
      && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  fi
fi
[ -x "$(command -v node)" ] && log "Node: $(node -v)  npm: $(npm -v)"

# ─── 3. 获取/准备源码 ───────────────────────────────────────
mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ "${MODE}" = "online" ]; then
  log "模式 B：线上拉取源码..."
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch origin && git -C "$APP_DIR" pull origin "$BRANCH"
  else
    git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
else
  log "模式 A：本地整包模式（已含 node_modules 与 data/fab.db）"
  # 当前目录即整包解压目录，无需拉取。若未见到源码则给提示
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/public/uploads"

# ─── 4. 校验/修复原生依赖（架构不匹配则重编译）────────────────
cd "$APP_DIR"
if [ -d node_modules ]; then
  log "检测到 node_modules，校验 better-sqlite3 与当前系统架构兼容性..."
  if ! node -e "require('better-sqlite3'); console.log('better-sqlite3 加载正常')" 2>/dev/null; then
    warn "better-sqlite3 与系统不匹配，正在重编译（需要 build 工具链）..."
    npm rebuild better-sqlite3 2>&1 | tail -5 || true
  fi
else
  log "未找到 node_modules，执行 npm install..."
  npm install --no-audit --no-fund 2>&1 | tail -8 || true
fi
node -e "require('better-sqlite3')" 2>/dev/null \
  || { err "better-sqlite3 仍无法加载，请确认已安装编译工具链后：npm rebuild better-sqlite3"; exit 1; }

# 确认数据库存在
if [ -f "$APP_DIR/data/fab.db" ]; then
  log "数据库已就绪: $(ls -lh "$APP_DIR/data/fab.db" | awk '{print $5}')"
else
  warn "未发现 data/fab.db，将由 server.js 首次启动自动创建空库。"
fi

chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" 2>/dev/null || true

# ─── 5. pm2 托管 ───────────────────────────────────────────
log "安装 pm2 ..."
npm install -g pm2 2>&1 | tail -3 || true
command -v pm2 >/dev/null 2>&1 || export PATH="$PATH:$(npm prefix -g)/bin"
export NODE_ENV=production
pm2 delete fab-handover 2>/dev/null || true
pm2 start server.js --name fab-handover --env production --time
pm2 save
pm2 startup systemd -u "$RUN_USER" --hp "/$RUN_USER" 2>/dev/null || pm2 startup 2>/dev/null || true

# ─── 6. nginx 反向代理 ─────────────────────────────────────
log "配置 nginx ..."
NGINX_CONF="/etc/nginx/conf.d/fab-handover.conf"
if [ "$PKG" = "apt" ]; then NGINX_CONF="/etc/nginx/sites-available/fab-handover"; fi
if [ -n "$DOMAIN" ]; then SERVER_NAME="$DOMAIN"; else SERVER_NAME="_"; fi
cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name $SERVER_NAME;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:${PORT_APP};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
if [ "$PKG" = "apt" ]; then
  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/fab-handover
  rm -f /etc/nginx/sites-enabled/default
fi
[ ! -f /etc/nginx/conf.d/default.conf ] || mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.bak 2>/dev/null || true
nginx -t && systemctl enable nginx --now 2>/dev/null || true
systemctl reload nginx 2>/dev/null || true

# ─── 7. 防火墙（腾讯云安全组在控制台配置，系统层仅放开即有规则）──
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH 2>/dev/null || true
  ufw allow 80/tcp 2>/dev/null || true
  ufw allow 443/tcp 2>/dev/null || true
  ufw --force enable 2>/dev/null || true
fi

# ─── 8. 可选 HTTPS ─────────────────────────────────────────
if [ -n "$DOMAIN" ] && [ "$AUTO_SSL" = "true" ]; then
  log "为 $DOMAIN 申请 Let's Encrypt 证书..."
  if [ "$PKG" = "apt" ]; then pkg_install certbot python3-certbot-nginx >/dev/null 2>&1 || true
  else pkg_install certbot python3-certbot-nginx >/dev/null 2>&1 || true; fi
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email 2>/dev/null || warn "证书申请失败，请检查域名解析"
fi

# ─── 9. 完成 ───────────────────────────────────────────────
IP=$(curl -s --max-time 5 ip.sb 2>/dev/null || curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "<公网IP>")
log ""
log "======================================================================"
[ -n "$DOMAIN" ] && URL="https://$DOMAIN" || URL="http://$IP"
log "  部署完成！"
log "  访问地址: ${URL}"
log "  默认管理员: admin / admin123 （登录后请立即修改）"
log "  重要：若公网打不开，请到腾讯云控制台 → 安全组 → 入站规则放行 TCP 80/443"
log "  进程管理: pm2 list | pm2 logs fab-handover | pm2 restart fab-handover"
log "  数据备份: cp $APP_DIR/data/fab.db /root/backups/fab-\$(date +%Y%m%d).db"
log "======================================================================"