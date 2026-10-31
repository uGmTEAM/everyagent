package cli

import (
	"fmt"
	"os"
	"strings"

	"mailcli/internal/out"
)

func Run(args []string) int {
	g, rest := extractGlobals(args)
	app := &App{g: g}
	if len(rest) == 0 {
		printUsage()
		return 0
	}
	name := strings.ToLower(rest[0])
	sub := rest[1:]

	var (
		data any
		meta map[string]any
		err  error
	)
	switch name {
	case "help", "-h", "--help":
		printUsage()
		return 0
	case "version", "--version":
		if app.g.Human {
			fmt.Printf("mail-cli %s\n", Version)
			return 0
		}
		return out.OK(map[string]string{"version": Version}, nil)
	case "init":
		data, meta, err = app.cmdInit(sub)
	case "accounts":
		data, meta, err = app.cmdAccounts(sub)
	case "doctor":
		data, meta, err = app.cmdDoctor(sub)
	case "folders":
		data, meta, err = app.cmdFolders(sub)
	case "list", "ls":
		data, meta, err = app.cmdList(sub)
	case "unread":
		data, meta, err = app.cmdUnread(sub)
	case "search":
		data, meta, err = app.cmdSearch(sub)
	case "read", "show":
		data, meta, err = app.cmdRead(sub)
	case "send":
		data, meta, err = app.cmdSend(sub)
	case "reply":
		data, meta, err = app.cmdReply(sub)
	case "forward", "fwd":
		data, meta, err = app.cmdForward(sub)
	case "mark":
		data, meta, err = app.cmdMark(sub)
	case "watch":
		data, meta, err = app.cmdWatch(sub)
	case "log":
		data, meta, err = app.cmdLog(sub)
	case "auth":
		data, meta, err = app.cmdAuth(sub)
	default:
		err = out.Usage("未知命令: " + name + "（mail help 查看用法）")
	}
	if err != nil {
		return out.Fail(mapErr(err))
	}
	if app.g.Human {
		return 0
	}
	if name == "watch" {
		return out.OKLine(data, meta)
	}
	return out.OK(data, meta)
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `mail-cli v%s — 多协议邮箱命令行工具（自动识别 IMAP/SMTP、Gmail API、Microsoft Graph）

用法:
  mail <命令> [参数] [--account 账号] [--config 路径] [--human]

常用命令:
  accounts                     列出账号与自动识别结果
  doctor [--connect]           诊断：识别依据、端口探测、真实登录
  folders                      列出文件夹
  unread [--limit 20]          未读邮件列表
  list [--folder INBOX]        邮件列表
  search --from x --subject y  按条件搜索
  read <ID> [--save-attachments]  读取正文，可选下载附件
  send --to a@b.com --subject S --text T [--html H] [--attach 文件]
  reply <ID> --text "..."      回复（自动带引用、写 References）
  forward <ID> --to b@c.com    转发
  mark <ID...> --seen|--unseen|--flag|--unflag
  watch [--interval 60] [--once] [--exec "脚本"]   轮询新邮件（NDJSON 流）
  log [--limit 50]             本地收发记录
  auth login --account X [--manual|--device]  OAuth 授权（Gmail/Graph）
  auth status | auth logout    OAuth 状态管理
  init [--path 路径]           生成配置模板
  version                      版本号

通用参数:
  --account NAME     指定账号（默认取 default_account）
  --config PATH      指定配置文件
  --data-dir DIR     指定数据目录（记录、token、状态）
  --timeout SEC      超时秒数，默认 30
  --human            人类可读输出（默认 JSON）
  --verbose          调试信息输出到 stderr

输出约定:
  成功: {"ok":true,"data":...,"meta":{...}}
  失败: {"ok":false,"error":{"code":"auth|network|not_found|usage","message":"...","hint":"..."}}
  退出码: 0 成功 / 1 通用 / 2 用法或配置 / 3 认证 / 4 网络或服务端 / 5 未找到

配置文件示例（mail init 生成）:
  default_account = "main"
  [accounts.main]
  email = "you@qq.com"
  password = "授权码"        # 或 password_env = "MAIL_PASS"
  # provider = "auto"        # auto/imap/gmail/graph
`, Version)
}
