package cli

import (
	"fmt"
	"strings"
	"time"

	"mailcli/internal/engine"
	"mailcli/internal/out"
	"mailcli/internal/store"
)

func (a *App) cmdSend(args []string) (any, map[string]any, error) {
	fs := newFlagSet("send")
	var to, cc, bcc, attach stringList
	var subject, text, textFile, htmlBody, htmlFile string
	fs.Var(&to, "to", "收件人，可重复或逗号分隔")
	fs.Var(&cc, "cc", "抄送")
	fs.Var(&bcc, "bcc", "密送")
	fs.Var(&attach, "attach", "附件路径，可重复；传目录则整目录添加")
	fs.StringVar(&subject, "subject", "", "邮件主题")
	fs.StringVar(&text, "text", "", "纯文本正文")
	fs.StringVar(&textFile, "text-file", "", "从文件读取正文，- 表示 stdin")
	fs.StringVar(&htmlBody, "html", "", "HTML 正文")
	fs.StringVar(&htmlFile, "html-file", "", "从文件读取 HTML 正文")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if len(to) == 0 {
		return nil, nil, out.Usage("缺少收件人，用法: mail send --to a@b.com --subject 主题 --text 正文")
	}
	text, htmlBody, err := readBody(text, textFile, htmlBody, htmlFile)
	if err != nil {
		return nil, nil, mapErr(err)
	}
	if text == "" && htmlBody == "" {
		return nil, nil, out.Usage("正文不能为空，使用 --text/--text-file/--html/--html-file 指定")
	}
	ctx, cancel := a.ctx()
	defer cancel()
	c, name, _, det, err := a.openClient(ctx)
	if err != nil {
		a.recordFailure(name, det.Provider, "", "", to, subject, err)
		return nil, nil, err
	}
	defer c.Close()
	id, err := c.Send(ctx, engine.SendRequest{
		To:          to,
		Cc:          cc,
		Bcc:         bcc,
		Subject:     subject,
		Text:        text,
		HTML:        htmlBody,
		Attachments: attach,
	})
	if err != nil {
		a.recordFailure(name, det.Provider, "", "", to, subject, err)
		return nil, nil, err
	}
	a.record(store.Record{
		Direction:   "out",
		Account:     name,
		Provider:    det.Provider,
		ID:          id,
		MessageID:   id,
		To:          to,
		Subject:     subject,
		Status:      "ok",
		Attachments: len(attach),
	})
	if a.g.Human {
		fmt.Printf("已发送: %s\n", subject)
	}
	return map[string]any{"message_id": id, "to": to, "subject": subject}, map[string]any{"account": name, "provider": det.Provider}, nil
}

func (a *App) recordFailure(account, provider, folder, id string, to []string, subject string, err error) {
	if account == "" {
		return
	}
	a.record(store.Record{
		Direction: "out",
		Account:   account,
		Provider:  provider,
		Folder:    folder,
		ID:        id,
		To:        to,
		Subject:   subject,
		Status:    "error",
		Error:     err.Error(),
	})
}

func (a *App) cmdReply(args []string) (any, map[string]any, error) {
	fs := newFlagSet("reply")
	var folder, text, textFile, htmlBody, htmlFile string
	var all bool
	var attach stringList
	fs.StringVar(&folder, "folder", "INBOX", "原邮件所在文件夹")
	fs.StringVar(&text, "text", "", "回复正文")
	fs.StringVar(&textFile, "text-file", "", "从文件读取正文，- 表示 stdin")
	fs.StringVar(&htmlBody, "html", "", "HTML 回复正文")
	fs.StringVar(&htmlFile, "html-file", "", "从文件读取 HTML 正文")
	fs.BoolVar(&all, "all", false, "回复全部（含原收件人与抄送）")
	fs.Var(&attach, "attach", "附件路径")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if fs.NArg() < 1 {
		return nil, nil, out.Usage("用法: mail reply <邮件ID> --text \"回复内容\"")
	}
	text, htmlBody, err := readBody(text, textFile, htmlBody, htmlFile)
	if err != nil {
		return nil, nil, mapErr(err)
	}
	ctx, cancel := a.ctx()
	defer cancel()
	c, name, acct, det, err := a.openClient(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer c.Close()
	origID := fs.Arg(0)
	orig, err := c.Get(ctx, folder, origID)
	if err != nil {
		return nil, nil, err
	}
	to := []string{orig.From}
	var cc []string
	if all {
		for _, addr := range orig.To {
			if !strings.Contains(addr, acct.Email) {
				to = append(to, addr)
			}
		}
		for _, addr := range orig.Cc {
			cc = append(cc, addr)
		}
	}
	quoteHeader := fmt.Sprintf("On %s, %s wrote:", orig.Date.Format("2006-01-02 15:04"), displayFrom(orig))
	quoted := quoteHeader + "\n" + quoteLines(orig.Text)
	if text != "" {
		text = text + "\n\n" + quoted
	} else {
		text = quoted
	}
	subject := orig.Subject
	if !strings.HasPrefix(strings.ToLower(subject), "re:") {
		subject = "Re: " + subject
	}
	refs := strings.TrimSpace(orig.MessageID)
	if refs == "" {
		refs = ""
	}
	id, err := c.Send(ctx, engine.SendRequest{
		To:          to,
		Cc:          cc,
		Subject:     subject,
		Text:        text,
		HTML:        htmlBody,
		Attachments: attach,
		InReplyTo:   orig.MessageID,
		References:  refs,
	})
	if err != nil {
		a.recordFailure(name, det.Provider, folder, origID, to, subject, err)
		return nil, nil, err
	}
	answered := true
	_ = c.Mark(ctx, folder, []string{origID}, nil, nil, &answered)
	a.record(store.Record{
		Direction: "out",
		Account:   name,
		Provider:  det.Provider,
		ID:        id,
		MessageID: id,
		To:        to,
		Subject:   subject,
		Status:    "ok",
	})
	if a.g.Human {
		fmt.Printf("已回复: %s -> %s\n", subject, strings.Join(to, ", "))
	}
	return map[string]any{"message_id": id, "to": to, "subject": subject, "in_reply_to": orig.MessageID}, map[string]any{"account": name, "provider": det.Provider}, nil
}

func (a *App) cmdForward(args []string) (any, map[string]any, error) {
	fs := newFlagSet("forward")
	var folder, text, textFile string
	var to stringList
	var attach stringList
	fs.StringVar(&folder, "folder", "INBOX", "原邮件所在文件夹")
	fs.Var(&to, "to", "收件人")
	fs.StringVar(&text, "text", "", "附加说明")
	fs.StringVar(&textFile, "text-file", "", "从文件读取说明")
	fs.Var(&attach, "attach", "附件路径")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if fs.NArg() < 1 || len(to) == 0 {
		return nil, nil, out.Usage("用法: mail forward <邮件ID> --to a@b.com [--text 说明]")
	}
	text, _, err := readBody(text, textFile, "", "")
	if err != nil {
		return nil, nil, mapErr(err)
	}
	ctx, cancel := a.ctx()
	defer cancel()
	c, name, _, det, err := a.openClient(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer c.Close()
	origID := fs.Arg(0)
	orig, err := c.Get(ctx, folder, origID)
	if err != nil {
		return nil, nil, err
	}
	subject := orig.Subject
	if !strings.HasPrefix(strings.ToLower(subject), "fwd:") {
		subject = "Fwd: " + subject
	}
	body := text
	if body != "" {
		body += "\n\n"
	}
	body += fmt.Sprintf("---------- Forwarded message ----------\nFrom: %s\nDate: %s\nSubject: %s\nTo: %s\n\n%s",
		displayFrom(orig), orig.Date.Format(time.RFC1123Z), orig.Subject, strings.Join(orig.To, ", "), orig.Text)
	id, err := c.Send(ctx, engine.SendRequest{
		To:          to,
		Subject:     subject,
		Text:        body,
		Attachments: attach,
	})
	if err != nil {
		a.recordFailure(name, det.Provider, folder, origID, to, subject, err)
		return nil, nil, err
	}
	a.record(store.Record{
		Direction: "out",
		Account:   name,
		Provider:  det.Provider,
		ID:        id,
		MessageID: id,
		To:        to,
		Subject:   subject,
		Status:    "ok",
	})
	if a.g.Human {
		fmt.Printf("已转发: %s -> %s\n", subject, strings.Join(to, ", "))
	}
	return map[string]any{"message_id": id, "to": to, "subject": subject}, map[string]any{"account": name, "provider": det.Provider}, nil
}

func displayFrom(m *engine.Message) string {
	if m.FromName != "" {
		return fmt.Sprintf("%s <%s>", m.FromName, m.From)
	}
	return m.From
}

func quoteLines(body string) string {
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	for i, line := range lines {
		lines[i] = "> " + line
	}
	return strings.Join(lines, "\n")
}
