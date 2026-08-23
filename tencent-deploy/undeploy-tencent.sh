#!/usr/bin/env bash
###############################################################################
# FAB 生产日常交接系统 — 腾讯云彻底删除旧部署脚本
# 功能：删除旧的 pm2 进程、nginx 反代配置、systemd 服务、项目目录与日志。
# 注意：默认【不删除】数据库 data/fab.db，避免误删数据；如需连同数据删除，
#       手动指定 SKIP_DATA=false 或确认后自行删除。
#
# 用法：
#   sudo bash undeploy-tencent.sh                    # 正常清理，保留数据库
#   sudo SKIP_DATA=false bash undeploy-tencent.sh     # 连数据库一起删除
###############################################################################
set -euo pipefail

APP_DIR="${APP_DIR:-/root/fab-handover-system}"
SKIP_DATA="${SKIP_DATA:-true}"          # true=保留数据，false=删除 data/fab.db

c_green='\033[0;32m'; c_yellow='\033[1;33m'; c_red='\033[0;31m'; c_reset='\033[0m'
log(){ echo -e "${c_green}[清理]${c_reset} $*"; }
warn(){ echo -e "${c_yellow}[警告]${c_reset} $*"; }

if [ "$(id -u)" -ne 0 ]; then err "请用 root 运行：sudo bash undeploy-tencent.sh"; exit 1; fi

log "===== 开始删除 FAB 协同系统旧部署 ====="

# ─── 1. 停止并删除 pm2 进程 ─────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
  log "删除 pm2 进程 fab-handover ..."
  pm2 delete fab-handover 2>/dev/null && echo "  ✓ 已删除 pm2 进程" || warn "  ✗ 无该 pm2 进程（跳过）"
  pm2 kill 2>/dev/null || true
  echo "  · 若需移除 pm2 开机自启，可执行: pm2 unstartup"
fi

# ─── 2. 删除 nginx 反代配置 ─────────────────────────────────
log "删除 nginx 配置 ..."
rm -f /etc/nginx/sites-enabled/fab-handover \
      /etc/nginx/conf.d/fab-handover.conf \
      /etc/nginx/sites-available/fab-handover 2>/dev/null || true
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
echo "  ✓ nginx 配置已移除并重载"

# ─── 3. 删除 systemd 服务（旧方案可选）──────────────────────
if [ -f /etc/systemd/system/fab-handover.service ]; then
  log "停止并删除 systemd 服务 ..."
  systemctl stop fab-handover 2>/dev/null || true
  systemctl disable fab-handover 2>/dev/null || true
  rm -f /etc/systemd/system/fab-handover.service
  systemctl daemon-reload 2>/dev/null || true
  echo "  ✓ systemd 服务已删除"
fi

# ─── 4. 删除项目源码目录（默认保留数据库）────────────────────
if [ -d "$APP_DIR" ]; then
  if [ "$SKIP_DATA" = "true" ]; then
    # 备份数据库再删源码
    BK="/root/backups/fab-backup-$(date +%Y%m%d-%H%M%S).db"
    if [ -f "$APP_DIR/data/fab.db" ]; then
      mkdir -p /root/backups
      cp "$APP_DIR/data/fab.db" "$BK"
      log "已备份数据库到: $BK"
    fi
    log "删除项目目录（保留已备份数据库）..."
    # 删除除 data 外全部，再删 data 下除 fab.db 外的文件
    find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2>/dev/null || true
    rm -rf "$APP_DIR/data"/[!f]* "$APP_DIR/data/"[!f]?? 2>/dev/null || true
    if [ -f "$APP_DIR/data/fab.db" ]; then
      warn "已保留数据库: $APP_DIR/data/fab.db"
    fi
  else
    log "删除项目目录（连同数据库）..."
    rm -rf "$APP_DIR"
  fi
  echo "  ✓ 项目源码目录处理完成"
else
  warn "  ✗ 项目目录不存在: $APP_DIR（跳过）"
fi

log ""
log "======================================================================"
log "  清理完成！"
[ "$SKIP_DATA" = "true" ] && log "  数据库已保留: $APP_DIR/data/fab.db（如需连数据删除：sudo SKIP_DATA=false bash undeploy-tencent.sh）"
log "  若更换域名/重装：可直接运行 deploy-tencent.sh 进行全新部署。"
log "======================================================================"