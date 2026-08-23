# FAB 生产日常交接系统 · 腾讯云 CVM 部署指南

> 本方案将**数据库（data/fab.db）+ JS/CSS 依赖包（node\_modules）+ 全部源码**整包部署到腾讯云服务器，服务器上无需联网拉依赖即可运行（离线友好）。适配 Ubuntu / Debian / CentOS / TencentOS。

***

## 一、部署流程（6 步）

1. 登录[腾讯云控制台](https://console.cloud.tencent.com)，购买/打开一台 **CVM 云服务器**（系统建议 Ubuntu 22.04 或 TencentOS，2核2G 及以上）。
2. 在 **安全组** 中放行 80、443 端口（公网访问必需）。
3. 下载本部署整包，上传到服务器。
4. 在服务器解压，运行 `deploy-tencent.sh`。
5. 浏览器访问 `http://<公网IP>`。
6. 用 `admin / admin123` 登录验证（登录后请立即修改密码）。

***

## 二、把整包上传到服务器（二选一）

### 方式 A：腾讯云「自带的 WebShell + 本机 scp」

```bash
# 在你本机（已安装 ssh/scp）执行：
# 1) 上传整包
scp "腾讯云部署包FAB交接系统含数据库依赖.tar.gz" root@<公网IP>:/root/

# 2) 服务器上解压（也可先改好端口/目录再解压）
tar -xzf /root/腾讯云部署包FAB交接系统含数据库依赖.tar.gz -C /root/
```

### 方式 B：腾讯云「文件上传」控制台

1. 控制台 → CVM → 登录实例 → 文件管理/上传。
2. 把整包上传到 `/root/`。
3. Shell 中执行 `tar -xzf /root/腾讯云部署包FAB交接系统含数据库依赖.tar.gz -C /root/`。

> 解压后会生成目录 `/root/fab-handover-system`。

***

## 三、运行一键部署脚本

默认已在 `/root/fab-handover-system/tencent-deploy/`，进入后执行：

```bash
cd /root/fab-handover-system/tencent-deploy
chmod +x deploy-tencent.sh
sudo bash deploy-tencent.sh
```

脚本自动完成：**先关闭原本在线的旧项目**（停止旧 pm2 / 释放 3000 与 80 端口 / 停用旧 systemd 服务）→ 装 Node 20 → 校验/重编译 `better-sqlite3`（架构不匹配时自动 `npm rebuild`）→ 确认数据库 → 全新启动 pm2 → 配置 nginx 反代（:80）。

* 若你的服务器**可联网**想重新拉依赖：`sudo bash deploy-tencent.sh online`

* 若绑定自定义域名 + HTTPS：`sudo DOMAIN=example.com AUTO_SSL=true bash deploy-tencent.sh`

> 因为你上传的是**整包**（已含 node\_modules），脚本走「模式 A」**不会**联网执行 `npm install`，仅本地校验原生模块，离线可用。

***

## 四、验证部署

| 步骤    | 命令/操作                                          | 预期                  |
| ----- | ---------------------------------------------- | ------------------- |
| 本机自测  | `curl -I http://localhost`                     | 返回 `200`            |
| 应用日志  | `pm2 logs fab-handover`                        | 打印「FAB 生产日常交接系统已启动」 |
| 远程访问  | 浏览器 `http://<公网IP>`                            | 显示登录页               |
| 登录测试  | `admin / admin123`                             | 进入仪表盘即成功            |
| 数据库校验 | `ls -lh /root/fab-handover-system/data/fab.db` | 体积与压缩包内一致（数据已带入）    |

> 若 `localhost` 通而公网 IP 不通：**99% 是腾讯云安全组未放行 80 端口**。到控制台 → 该 CVM → 安全组 → 添加入站规则「TCP 80 来源 0.0.0.0/0」。

***

## 五、进程守护（pm2）

脚本已用 `pm2` 托管（自带日志、崩溃重启、开机自启）：

```bash
pm2 list                              # 查看进程
pm2 restart fab-handover             # 重启
pm2 logs fab-handover                # 查看日志
pm2 stop fab-handover                # 停止
```

***

## 六、数据库备份（务必养成习惯）

SQLite 是单文件，热备份一行搞定：

```bash
mkdir -p /root/backups
# 每日凌晨 2 点自动备份
echo "0 2 * * * cp /root/fab-handover-system/data/fab.db /root/backups/fab-\$(date +\%Y\%m\%d).db" | crontab -
```

***

## 七、常见问题（FAQ）

| 现象                    | 排查                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------ |
| 公网打不开，localhost 通     | 腾讯云安全组未放行 80/443 入站                                                                        |
| `better-sqlite3` 加载失败 | CPU 架构不符时脚本已自动重编译；仍失败手动 `npm rebuild better-sqlite3`                                       |
| 上传图片 404              | 检查 `public/uploads` 目录权限与 nginx `client_max_body_size`                                     |
| 用域名访问                 | 控制台解析 A 记录到公网 IP，重建 nginx 或用 `DOMAIN=` 重跑脚本                                                |
| 忘记密码/账号锁定             | 直接改库：`sqlite3 /root/fab-handover-system/data/fab.db "update users set password='<新hash>'"` |

***

## 八、安全提示

* 登录后**立即修改默认 admin 密码**。

* 若仅自己使用，安全组 22 端口只放行你的固定 IP。

* 建议启用 HTTPS（绑定域名后 `AUTO_SSL=true` 自动申请证书）。

