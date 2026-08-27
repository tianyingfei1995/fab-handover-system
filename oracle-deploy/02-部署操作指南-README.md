# 部署操作指南（RHEL / Ubuntu 通用）

> 本部署包配套说明，覆盖：准备服务器 → 上传代码 → 运行部署脚本 → 验证 → 数据迁移 → 故障排查。
> `deploy.sh` 会自动识别系统：**RHEL 8/9**（含 Rocky/Alma/Oracle Linux，用 dnf + firewalld）与 **Ubuntu 22.04/24.04**（用 apt + ufw）。

## 目录文件说明

| 文件 | 用途 |
|------|------|
| `01-开户清单-README.md` | Oracle Cloud 开户准备材料 + 分步开户指引 |
| `deploy.sh` | 服务器上一键部署脚本（Node20 + 依赖 + pm2 + nginx，自动识别 RHEL/Ubuntu） |
| `03-systemd-fab-handover.service` | 可选的 systemd 守护方式（与 pm2 二选一，RHEL/Ubuntu 通用） |

---

## 一、整体流程（6 步）

1. 按 `01-开户清单` 在 Oracle Console 注册账号并创建 **ARM 虚拟机**
2. 用 SSH 登录新服务器（`ssh -i fab_key ubuntu@<公网IP>`）
3. 把本项目源码上传到服务器（推荐 Git clone，见下）
4. 运行部署脚本 `sudo bash deploy.sh`
5. 在 OCI 防火墙开放 80 端口（虚拟机安全列表 + 子网）
6. 浏览器访问公网 IP，用 `admin / admin123` 登录验证

---

## 二、把代码放到服务器（二选一）

### 方式 A：Git clone（推荐）
服务器上执行：
```bash
git clone https://github.com/tianyingfei1995/fab-handover-system.git /root/fab-handover-system
```
> 注意：仓库是**私有**的，需在 GitHub 生成 token 或用 `gh auth`，或服务端配 credential。若嫌麻烦可直接用方式 B。

### 方式 B：scp/SFTP 上传源码包
在你本机打包：
```bash
tar -czf fab-handover.tar.gz --exclude=node_modules --exclude=data --exclude=public/uploads fab-handover-system
scp fab-handover.tar.gz ubuntu@<公网IP>:/root/
```
然后在服务器解压到 `/root/fab-handover-system`。

---

## 三、运行部署脚本

上传 `deploy.sh` 到服务器（与上述任意一种方式的人同步），然后：
```bash
sudo bash /root/deploy.sh
```
脚本会自动完成：装 Node20 → 装编译工具链(better-sqlite3) → 装依赖 → pm2 托管 → nginx 反代 → 开放防火墙。失败时脚本会输出明确错误定位。

---

## 四、验证部署是否成功

1. **本机自测**（服务器上）：`curl -I http://localhost` 应返回 `200`
2. **应用日志**：`pm2 logs fab-handover` 查看启动日志，正常会打印 `FAB 生产日常交接系统已启动`
3. **远程访问**：浏览器打开 `http://<公网IP>` 应看到登录页
4. **登录测试**：`admin / admin123` 进入仪表盘即成功

> 若 `localhost` 通而公网 IP 不通，99% 是 **OCI 网络安全列表未放行 80 端口**。到控制台：你的 VM → 子网 → 安全列表 → 添加入站规则「HTTP 80 来源 0.0.0.0/0」。

---

## 五、数据迁移（把本地数据带到服务器）

你的本地 `data/fab.db` 和 `public/uploads` 是真实数据，上线前迁移：
```bash
# 本机执行
scp ./data/fab.db ubuntu@<公网IP>:/root/fab-handover-system/data/
scp -r ./public/uploads ubuntu@<公网IP>:/root/fab-handover-system/public/uploads/
# 服务器重启应用
pm2 restart fab-handover
```
> 首次部署最好先把空库跑通，再用上面方式导入，避免覆盖冲突。

---

## 六、进程守护说明（pm2 vs systemd）

当前脚本默认用 **pm2**（推荐，自带日志、自启、监控面板）。`03-systemd` 是轻量替代，若用 systemd：
```bash
sudo cp 03-systemd-fab-handover.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fab-handover
systemctl status fab-handover
```
**注意**：两种守护只能启用其一，否则端口 3000 会被两个进程抢。用 pm2 时无需管 systemd。

---

## 七、数据库备份（务必养成习惯）

SQLite 是单文件，热备份一行搞定：
```bash
# 每天定时备份（示例 cron：每天凌晨 2 点）
echo "0 2 * * * cp /root/fab-handover-system/data/fab.db /root/backups/fab-$(date +\%Y%m%d).db" | crontab -
```

---

## 八、常见问题（FAQ）

| 现象 | 排查 |
|------|------|
| 公网 IP 打不开，localhost 通 | OCI 安全列表未放行 80/443 |
| `better-sqlite3` 编译失败 | RHEL：`dnf groupinstall "Development Tools" && dnf install sqlite-devel`；Ubuntu：`apt install build-essential libsqlite3-dev`；然后 `npm rebuild better-sqlite3` |
| 上传图片 404 | `public/uploads` 目录权限；nginx `client_max_body_size` |
| 想让系统从未登录过的域名访问 | 解析 A 记录到公网 IP，`DOMAIN=xxx bash deploy.sh` 配 HTTPS |
| 账号被锁定 / 忘密码 | 直接改 SQLite：`sqlite3 data/fab.db "update users set password='新hash'"` |

---

## 九、安全提示

- 登录后**立即修改默认 admin 密码**。
- 若不需要 SSH 公网访问，只在 OCI 安全列表放行来自你固定 IP 的 22 端口。
- 建议为域名开启 Let's Encrypt（脚本 `AUTO_SSL=true` 自动完成）。