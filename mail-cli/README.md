# mail-cli

Linux 单文件邮箱命令行工具。自动识别 **IMAP/SMTP**、**Gmail API**、**Microsoft Graph** 三类通道，覆盖未读、读取、发送、回复、转发、搜索、标记、附件下载与收件箱轮询，默认输出 JSON，便于 AI 通过 shell 调用。

- 静态编译，无运行时依赖（CGO_ENABLED=0），可直接拷进容器
- 默认 JSON 信封输出；`--human` 切换为表格/正文
- 单账号、多账号（`config.toml` 分段）
- 收发记录落 JSONL，可直接 grep

## 安装

```bash
install -m 0755 mail /usr/local/bin/mail
mail version
```

## 快速开始

```bash
mail init --path ~/.config/mail-cli/config.toml   # 生成模板（权限 600）
vi ~/.config/mail-cli/config.toml                 # 填 email + password/授权码
mail doctor --connect --human                     # 查看识别结果与真实登录
mail unread --limit 10
```

## 配置

```toml
default_account = "main"
# data_dir = "/var/lib/mail-cli"   # 记录、token、状态目录
timeout_seconds = 30

[accounts.main]
email = "you@qq.com"
password = "授权码"          # 或 password_env = "MAIL_PASS"
display_name = "张三"
provider = "auto"           # auto | imap | gmail | graph
# host = ""                 # 留空自动探测
# port = 993
# tls = "ssl"               # ssl | starttls | none
# smtp_host = ""
# smtp_port = 465
# smtp_tls = "ssl"
# sent_folder = ""          # 留空自动识别「已发送」
# attach_dir = ""           # 附件默认保存目录
# insecure_skip_verify = false
```

OAuth 账号（Gmail / Outlook）额外字段：

```toml
[accounts.mail]
email = "me@gmail.com"
provider = "gmail"          # 或 graph
client_id = "xxx.apps.googleusercontent.com"
client_secret = ""          # 公共客户端可留空
# tenant = "common"         # 仅 graph
# api_base = ""             # 私有化/测试用接口地址
```

token 保存在 `data_dir/oauth.json`，不会回写配置文件。

## 通道自动识别

优先级从高到低：

1. `provider` 显式指定
2. 凭证嗅探：存在 `client_id` 且（有 `refresh_token` 或无密码）→ Gmail API / Graph
3. 域名预设：qq / 163 / 126 / aliyun / exmail / outlook / icloud / yahoo / gmx / feishu 等
4. MX 记录推断（自建域名托管在 QQ 企业邮、阿里云、网易企业邮等）
5. 常见主机名探测（`imap.<domain>` 等，含 TLS 握手与 banner 校验）

`mail doctor` 会打印最终判定、依据与探测记录；未命中时在配置里显式写 `host/port/tls` 即可。

## 命令

| 命令 | 说明 |
| --- | --- |
| `mail accounts` | 列出账号、类型、认证方式 |
| `mail doctor [--connect]` | 诊断识别与连通性 |
| `mail folders` | 文件夹列表（含总数/未读数） |
| `mail unread [--limit 20]` | 未读邮件 |
| `mail list [--folder INBOX] [--unread]` | 邮件列表 |
| `mail search --from x --subject y --since 2026-10-01` | 搜索 |
| `mail read <ID> [--save-attachments] [--attach-dir DIR] [--html]` | 正文与附件 |
| `mail send --to a@b.com --subject S --text T [--cc --bcc --attach 文件] [--html H]` | 发送 |
| `mail reply <ID> --text "..." [--all]` | 回复（自动引用 + In-Reply-To/References） |
| `mail forward <ID> --to b@c.com` | 转发 |
| `mail mark <ID...> --seen/--unseen/--flag/--unflag/--answered` | 标记 |
| `mail watch [--interval 60] [--once] [--exec "cmd"]` | 轮询新邮件（NDJSON 流） |
| `mail log [--limit 50] [--direction in/out]` | 本地收发记录 |
| `mail auth login [--manual/--device]` | OAuth 授权 |
| `mail auth status / logout` | token 状态 |
| `mail init` | 生成配置模板 |

正文也可从文件或 stdin 读取：`--text-file body.txt`、`--text-file -`。

常用全局参数：`--account NAME`、`--config PATH`、`--data-dir DIR`、`--timeout SEC`、`--human`、`--verbose`。

## 输出约定

成功：

```json
{"ok": true, "data": {...}, "meta": {"account": "main", "provider": "imap"}}
```

失败（stdout 同样输出 JSON，便于程序解析）：

```json
{"ok": false, "error": {"code": "auth", "message": "...", "hint": "..."}}
```

退出码：`0` 成功 / `1` 通用 / `2` 用法或配置 / `3` 认证 / `4` 网络或服务端 / `5` 未找到。

`watch` 为流式命令：每封新邮件输出一行事件 JSON，退出时输出一行汇总信封：

```json
{"type":"new_mail","at":"...","account":"main","provider":"imap","folder":"INBOX","message":{...}}
```

## OAuth 登录

```bash
# 有浏览器（本机或端口转发）
mail auth login --account mail

# 无浏览器：手动粘贴回调 URL
mail auth login --account mail --manual

# Microsoft 设备码
mail auth login --account mail --device
```

Gmail 默认 IMAP + 应用专用密码即可，只有在使用 Gmail API 时才需要 OAuth；Outlook 个人账号已基本要求 OAuth。

## 轮询示例（systemd）

```ini
[Unit]
Description=mail-cli watch
After=network-online.target

[Service]
ExecStart=/usr/local/bin/mail watch --interval 60 --exec '/usr/local/bin/on-mail.sh'
Restart=always
Environment=MAIL_CLI_CONFIG=/etc/mail-cli/config.toml

[Install]
WantedBy=multi-user.target
```

`--exec` 脚本可读取环境变量：`MAIL_ACCOUNT`、`MAIL_FOLDER`、`MAIL_ID`、`MAIL_SUBJECT`、`MAIL_FROM`。

## 数据目录

默认 `~/.local/share/mail-cli`：

- `records.jsonl`：收发记录（追加写）
- `state.json`：轮询基线（每账号/文件夹最后 UID、最后检查时间）
- `oauth.json`：OAuth token（权限 600）

## 常见问题

- **QQ / 163**：需在网页端开启 IMAP 服务，密码填「授权码」而非登录密码；本工具登录后会发送 `ID` 命令声明客户端身份。
- **Gmail**：使用 IMAP 时需开启两步验证并生成应用专用密码；或配置 `provider = "gmail"` + `client_id` 走 API。
- **Outlook / Microsoft 365**：建议 `provider = "graph"` + OAuth；IMAP 需账号已启用。
- **自建域名**：`doctor` 未命中时手动填写 `host/port/tls/smtp_host/smtp_port/smtp_tls`。
- **证书错误**：仅测试环境使用 `insecure_skip_verify = true`。

## 从源码构建

```bash
# 任意 Linux + Go 1.22+
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o mail .
```

Windows 上一键构建（临时容器内装 Go 编译，不污染本机）：

```powershell
powershell -File tools/build-mail-cli.ps1
```

## 测试

```bash
go test ./internal/... -timeout 90s
```

测试内置极简 IMAP/SMTP 服务端（`internal/testutil`），覆盖：未读列表、正文/附件、标记、发送与已发送追加、CLI JSON 输出、watch 基线与新邮件事件。
