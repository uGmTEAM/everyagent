package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mailcli/internal/config"
	"mailcli/internal/detect"
	"mailcli/internal/engine"
	"mailcli/internal/out"
	"mailcli/internal/store"
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

// parseMixed 支持「位置参数在前、选项在后」的写法，例如 mail read 12 --save-attachments
func parseMixed(fs *flag.FlagSet, args []string) error {
	valueFlags := map[string]bool{}
	fs.VisitAll(func(f *flag.Flag) {
		if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
			return
		}
		valueFlags[f.Name] = true
	})
	flags := make([]string, 0, len(args))
	positional := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		if strings.HasPrefix(a, "-") && a != "-" {
			flags = append(flags, a)
			name := strings.TrimLeft(a, "-")
			if !strings.Contains(name, "=") && valueFlags[name] && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		positional = append(positional, a)
	}
	return fs.Parse(append(flags, positional...))
}

type listFlags struct {
	folder  string
	limit   int
	unread  bool
	read    bool
	flagged bool
	since   string
	before  string
	from    string
	to      string
	subject string
	text    string
	body    string
}

func (a *App) registerListFlags(fs *flag.FlagSet, lf *listFlags) {
	fs.StringVar(&lf.folder, "folder", "INBOX", "邮箱文件夹")
	fs.IntVar(&lf.limit, "limit", 20, "返回条数")
	fs.BoolVar(&lf.unread, "unread", false, "只看未读")
	fs.BoolVar(&lf.read, "seen", false, "只看已读")
	fs.BoolVar(&lf.flagged, "flagged", false, "只看星标")
	fs.StringVar(&lf.since, "since", "", "起始日期 YYYY-MM-DD")
	fs.StringVar(&lf.before, "before", "", "截止日期 YYYY-MM-DD")
	fs.StringVar(&lf.from, "from", "", "发件人包含")
	fs.StringVar(&lf.to, "to", "", "收件人包含")
	fs.StringVar(&lf.subject, "subject", "", "主题包含")
	fs.StringVar(&lf.text, "text", "", "全文包含")
	fs.StringVar(&lf.body, "body", "", "正文包含")
}

func (lf *listFlags) query() (engine.Query, error) {
	q := engine.Query{
		Folder:  lf.folder,
		Limit:   lf.limit,
		From:    lf.from,
		To:      lf.to,
		Subject: lf.subject,
		Text:    lf.text,
		Body:    lf.body,
	}
	if lf.unread {
		v := true
		q.Unread = &v
	}
	if lf.read {
		v := false
		q.Unread = &v
	}
	if lf.flagged {
		v := true
		q.Flagged = &v
	}
	if lf.since != "" {
		t, err := parseDate(lf.since)
		if err != nil {
			return q, fmt.Errorf("--since 格式错误: %v", err)
		}
		q.Since = t
	}
	if lf.before != "" {
		t, err := parseDate(lf.before)
		if err != nil {
			return q, fmt.Errorf("--before 格式错误: %v", err)
		}
		q.Before = t
	}
	return q, nil
}

func parseDate(s string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02", "2006/01/02", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("无法解析日期 %q（示例 2026-10-29）", s)
}

func (a *App) cmdList(args []string) (any, map[string]any, error) {
	fs := newFlagSet("list")
	lf := &listFlags{}
	a.registerListFlags(fs, lf)
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	ctx, cancel := a.ctx()
	defer cancel()
	c, name, _, det, err := a.openClient(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer c.Close()
	q, err := lf.query()
	if err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	msgs, err := c.List(ctx, lf.folder, q)
	if err != nil {
		return nil, nil, err
	}
	meta := map[string]any{"account": name, "provider": det.Provider, "folder": lf.folder, "count": len(msgs)}
	if a.g.Human {
		printMessageTable(msgs)
	}
	return msgs, meta, nil
}

func (a *App) cmdUnread(args []string) (any, map[string]any, error) {
	return a.cmdList(append([]string{"--unread"}, args...))
}

func (a *App) cmdSearch(args []string) (any, map[string]any, error) {
	return a.cmdList(args)
}

func (a *App) cmdFolders(args []string) (any, map[string]any, error) {
	fs := newFlagSet("folders")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	ctx, cancel := a.ctx()
	defer cancel()
	c, name, _, det, err := a.openClient(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer c.Close()
	folders, err := c.Folders(ctx)
	if err != nil {
		return nil, nil, err
	}
	if a.g.Human {
		for _, f := range folders {
			fmt.Printf("%-28s 共 %-6d 未读 %d\n", f.Name, f.Messages, f.Unread)
		}
	}
	return folders, map[string]any{"account": name, "provider": det.Provider, "count": len(folders)}, nil
}

func (a *App) cmdRead(args []string) (any, map[string]any, error) {
	fs := newFlagSet("read")
	var (
		folder   string
		saveAtt  bool
		attachIn string
		showHTML bool
	)
	fs.StringVar(&folder, "folder", "INBOX", "邮箱文件夹")
	fs.BoolVar(&saveAtt, "save-attachments", false, "下载附件到本地")
	fs.StringVar(&attachIn, "attach-dir", "", "附件保存目录")
	fs.BoolVar(&showHTML, "html", false, "同时返回原始 HTML")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if fs.NArg() < 1 {
		return nil, nil, out.Usage("用法: mail read <邮件ID> [--folder INBOX] [--save-attachments]")
	}
	id := fs.Arg(0)
	ctx, cancel := a.ctx()
	defer cancel()
	c, name, acct, det, err := a.openClient(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer c.Close()
	msg, err := c.Get(ctx, folder, id)
	if err != nil {
		return nil, nil, err
	}
	if !showHTML {
		msg.HTML = ""
	}
	if saveAtt {
		dir := attachIn
		if dir == "" {
			if acct.AttachDir != "" {
				dir = acct.AttachDir
			} else {
				dir = filepath.Join(".", "attachments")
			}
		}
		saved, err := c.SaveAttachments(ctx, folder, id, dir)
		if err != nil {
			return nil, nil, err
		}
		if len(saved) > 0 {
			msg.Attachments = saved
		}
	}
	if a.g.Human {
		printMessageDetail(msg)
	}
	return msg, map[string]any{"account": name, "provider": det.Provider, "folder": folder}, nil
}

func (a *App) cmdMark(args []string) (any, map[string]any, error) {
	fs := newFlagSet("mark")
	var (
		folder   string
		seen     bool
		unseen   bool
		flagged  bool
		unflag   bool
		answered bool
	)
	fs.StringVar(&folder, "folder", "INBOX", "邮箱文件夹")
	fs.BoolVar(&seen, "seen", false, "标记为已读")
	fs.BoolVar(&unseen, "unseen", false, "标记为未读")
	fs.BoolVar(&flagged, "flag", false, "加星标")
	fs.BoolVar(&unflag, "unflag", false, "取消星标")
	fs.BoolVar(&answered, "answered", false, "标记为已回复")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if fs.NArg() < 1 {
		return nil, nil, out.Usage("用法: mail mark <邮件ID...> [--seen|--unseen|--flag|--unflag]")
	}
	var seenPtr, flagPtr, ansPtr *bool
	if seen && unseen {
		return nil, nil, out.Usage("--seen 与 --unseen 不能同时使用")
	}
	if seen {
		v := true
		seenPtr = &v
	} else if unseen {
		v := false
		seenPtr = &v
	}
	if flagged && unflag {
		return nil, nil, out.Usage("--flag 与 --unflag 不能同时使用")
	}
	if flagged {
		v := true
		flagPtr = &v
	} else if unflag {
		v := false
		flagPtr = &v
	}
	if answered {
		v := true
		ansPtr = &v
	}
	if seenPtr == nil && flagPtr == nil && ansPtr == nil {
		return nil, nil, out.Usage("至少指定一个标记动作（--seen/--unseen/--flag/--unflag/--answered）")
	}
	ctx, cancel := a.ctx()
	defer cancel()
	c, name, _, det, err := a.openClient(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer c.Close()
	ids := fs.Args()
	if err := c.Mark(ctx, folder, ids, seenPtr, flagPtr, ansPtr); err != nil {
		return nil, nil, err
	}
	if a.g.Human {
		fmt.Printf("已更新 %d 封邮件的标记\n", len(ids))
	}
	return map[string]any{"ids": ids, "folder": folder}, map[string]any{"account": name, "provider": det.Provider}, nil
}

func (a *App) cmdAccounts(args []string) (any, map[string]any, error) {
	fs := newFlagSet("accounts")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if err := a.loadConfig(); err != nil {
		return nil, nil, mapErr(err)
	}
	type accountInfo struct {
		Name      string `json:"name"`
		Email     string `json:"email"`
		Provider  string `json:"provider"`
		Auth      string `json:"auth"`
		Default   bool   `json:"default"`
		HasSecret bool   `json:"has_secret"`
	}
	var list []accountInfo
	for name, acct := range a.cfg.Accounts {
		det, err := a.detect(context.Background(), acct)
		provider := acct.Provider
		if err == nil {
			provider = det.Provider
		}
		auth := "password"
		if provider == "gmail" || provider == "graph" {
			auth = "oauth2"
		}
		list = append(list, accountInfo{
			Name:      name,
			Email:     acct.Email,
			Provider:  provider,
			Auth:      auth,
			Default:   name == a.cfg.DefaultAccount,
			HasSecret: acct.ResolvePassword() != "" || acct.RefreshToken != "",
		})
	}
	if a.g.Human {
		fmt.Printf("配置文件: %s\n", a.cfg.Path)
		sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		for _, it := range list {
			fmt.Printf("%-12s %-28s %-6s %-9s 默认:%v\n", it.Name, it.Email, it.Provider, it.Auth, it.Default)
		}
	}
	return list, map[string]any{"config": a.cfg.Path, "count": len(list)}, nil
}

func (a *App) cmdDoctor(args []string) (any, map[string]any, error) {
	fs := newFlagSet("doctor")
	var connect bool
	fs.BoolVar(&connect, "connect", false, "尝试真实连接登录")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	name, acct, err := a.account()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	ctx, cancel := a.ctx()
	defer cancel()
	det, err := a.detect(ctx, acct)
	if err != nil {
		return nil, nil, mapErr(err)
	}
	result := map[string]any{
		"account":   name,
		"email":     acct.Email,
		"email_key": "",
		"detection": det,
	}
	if connect {
		st, err := a.dataStore()
		if err != nil {
			return nil, nil, mapErr(err)
		}
		c, err := engine.Open(ctx, engine.Options{
			AccountName: name,
			Account:     acct,
			Det:         det,
			Store:       st,
			Timeout:     time.Duration(a.g.Timeout) * time.Second,
		})
		if err != nil {
			result["connect"] = map[string]any{"ok": false, "error": err.Error()}
			if a.g.Human {
				printDoctor(result, det)
			}
			return result, map[string]any{"account": name}, mapErr(err)
		}
		defer c.Close()
		folders, ferr := c.Folders(ctx)
		if ferr != nil {
			result["connect"] = map[string]any{"ok": false, "error": ferr.Error()}
			if a.g.Human {
				printDoctor(result, det)
			}
			return result, map[string]any{"account": name}, mapErr(ferr)
		}
		result["connect"] = map[string]any{"ok": true, "folders": len(folders)}
	}
	if a.g.Human {
		printDoctor(result, det)
	}
	return result, map[string]any{"account": name, "provider": det.Provider}, nil
}

func printDoctor(_ map[string]any, det *detect.Result) {
	fmt.Printf("供应商: %s\nIMAP: %s:%d (%s)\nSMTP: %s:%d (%s)\n", det.Provider, det.Host, det.Port, det.TLS, det.SMTPHost, det.SMTPPort, det.SMTPTLS)
	fmt.Println("判定依据:")
	for _, r := range det.Reasons {
		fmt.Println("  -", r)
	}
	if len(det.Probes) > 0 {
		fmt.Println("探测记录:")
		for _, p := range det.Probes {
			fmt.Println("  -", p)
		}
	}
}

func (a *App) cmdLog(args []string) (any, map[string]any, error) {
	fs := newFlagSet("log")
	var limit int
	var direction string
	fs.IntVar(&limit, "limit", 50, "返回条数")
	fs.StringVar(&direction, "direction", "", "in | out")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	st, err := a.dataStore()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	records, err := st.Tail(0)
	if err != nil {
		return nil, nil, mapErr(err)
	}
	var filtered = []storeRecord{}
	for _, r := range records {
		if direction != "" && r.Direction != direction {
			continue
		}
		filtered = append(filtered, storeRecord(r))
	}
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[len(filtered)-limit:]
	}
	if a.g.Human {
		for _, r := range filtered {
			fmt.Printf("%s %-3s %-16s %-28s %s\n", r.Time.Format("01-02 15:04"), r.Direction, r.From, truncateDisplay(r.Subject, 40), r.Status)
		}
	}
	return filtered, map[string]any{"count": len(filtered), "data_dir": st.Dir()}, nil
}

func truncateDisplay(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

func (a *App) cmdInit(args []string) (any, map[string]any, error) {
	fs := newFlagSet("init")
	var path string
	fs.StringVar(&path, "path", "", "配置文件路径")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if path == "" {
		paths := config.DefaultSearchPaths()
		if len(paths) == 0 {
			return nil, nil, out.General("无法确定用户目录")
		}
		path = paths[len(paths)-1]
	}
	if _, err := os.Stat(path); err == nil {
		return nil, nil, out.Usage("配置文件已存在: " + path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, mapErr(err)
	}
	if err := os.WriteFile(path, []byte(config.Template()), 0o600); err != nil {
		return nil, nil, mapErr(err)
	}
	if a.g.Human {
		fmt.Printf("已生成配置模板: %s\n", path)
	}
	return map[string]any{"path": path}, nil, nil
}

func printMessageTable(msgs []engine.Message) {
	if len(msgs) == 0 {
		fmt.Println("（无邮件）")
		return
	}
	fmt.Printf("%-6s %-16s %-28s %-4s %s\n", "ID", "时间", "发件人", "新", "主题")
	for _, m := range msgs {
		flag := " "
		if m.Unread {
			flag = "●"
		}
		from := m.From
		if m.FromName != "" {
			from = m.FromName + " <" + m.From + ">"
		}
		fmt.Printf("%-6s %-16s %-28s %-4s %s\n",
			truncateDisplay(m.ID, 6),
			m.Date.Local().Format("01-02 15:04"),
			truncateDisplay(from, 26),
			flag,
			truncateDisplay(m.Subject, 60))
	}
}

func printMessageDetail(m *engine.Message) {
	fmt.Printf("主题: %s\n发件人: %s <%s>\n收件人: %s\n时间: %s\nID: %s\n\n%s\n",
		m.Subject, m.FromName, m.From, strings.Join(m.To, ", "), m.Date.Local().Format(time.RFC3339), m.ID, m.Text)
	if len(m.Attachments) > 0 {
		fmt.Println("\n附件:")
		for _, a := range m.Attachments {
			if a.SavedPath != "" {
				fmt.Printf("  - %s (%d bytes) -> %s\n", a.Filename, a.Size, a.SavedPath)
			} else {
				fmt.Printf("  - %s (%s, %d bytes)\n", a.Filename, a.ContentType, a.Size)
			}
		}
	}
}

// 供 send/reply 读取正文
func readBody(text, textFile, html, htmlFile string) (string, string, error) {
	var err error
	if textFile != "" {
		text, err = readFileOrStdin(textFile)
		if err != nil {
			return "", "", err
		}
	}
	if htmlFile != "" {
		html, err = readFileOrStdin(htmlFile)
		if err != nil {
			return "", "", err
		}
	}
	return text, html, nil
}

func readFileOrStdin(path string) (string, error) {
	if path == "-" {
		b, err := io.ReadAll(io.LimitReader(os.Stdin, 8<<20))
		return string(b), err
	}
	b, err := os.ReadFile(path)
	return string(b), err
}

type storeRecord = store.Record
