package engine

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	imap "github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	"github.com/emersion/go-imap/responses"

	"mailcli/internal/config"
	"mailcli/internal/detect"
	"mailcli/internal/mailparse"
)

const maxRawMessage = 64 << 20

type imapClient struct {
	acct    *config.Account
	det     *detect.Result
	c       *client.Client
	timeout time.Duration
}

func newIMAP(ctx context.Context, o Options) (*imapClient, error) {
	acct := o.Account
	det := o.Det
	if det.Host == "" {
		return nil, ewrap(KindConfig, fmt.Errorf("缺少 IMAP 服务器地址，请检查配置或执行 mail doctor"))
	}
	port := det.Port
	if port == 0 {
		port = 993
	}
	host := det.Host
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	tlsCfg := &tls.Config{ServerName: host, InsecureSkipVerify: acct.InsecureSkipVerify}
	dialer := &net.Dialer{Timeout: o.Timeout}

	var c *client.Client
	var err error
	switch strings.ToLower(det.TLS) {
	case "ssl", "tls", "":
		c, err = client.DialWithDialerTLS(dialer, addr, tlsCfg)
	case "starttls":
		c, err = client.DialWithDialer(dialer, addr)
		if err == nil {
			err = c.StartTLS(tlsCfg)
		}
	case "none":
		c, err = client.DialWithDialer(dialer, addr)
	default:
		return nil, ewrap(KindConfig, fmt.Errorf("未知 IMAP TLS 模式: %s", det.TLS))
	}
	if err != nil {
		return nil, ewrap(KindNetwork, fmt.Errorf("IMAP 连接 %s 失败: %w", addr, err))
	}
	if pass := acct.ResolvePassword(); pass == "" {
		c.Logout()
		return nil, ewrap(KindAuth, fmt.Errorf("缺少密码/授权码"))
	}
	if err := c.Login(acct.Username, acct.ResolvePassword()); err != nil {
		c.Logout()
		return nil, ewrap(KindAuth, fmt.Errorf("IMAP 登录失败: %w", err))
	}
	ic := &imapClient{acct: acct, det: det, c: c, timeout: o.Timeout}
	ic.trySendID()
	return ic, nil
}

// trySendID 部分国内邮箱（QQ/163）要求客户端声明身份，失败不影响主流程
func (c *imapClient) trySendID() {
	cmd := &imap.Command{
		Name:      "ID",
		Arguments: []interface{}{imap.RawString(`("name" "mail-cli" "version" "1.0" "vendor" "everyagent")`)},
	}
	_, _ = c.c.Execute(&idCommander{cmd: cmd}, responses.HandlerFunc(func(resp imap.Resp) error {
		return nil
	}))
}

type idCommander struct{ cmd *imap.Command }

func (c *idCommander) Command() *imap.Command { return c.cmd }
func (c *idCommander) Handle(resp imap.Resp) error {
	return nil
}

func (c *imapClient) Provider() string { return "imap" }

func (c *imapClient) Close() error {
	if c.c == nil {
		return nil
	}
	return c.c.Logout()
}

func (c *imapClient) Folders(ctx context.Context) ([]Folder, error) {
	mailboxes := make(chan *imap.MailboxInfo, 64)
	done := make(chan error, 1)
	go func() { done <- c.c.List("", "*", mailboxes) }()
	var out []Folder
	for mb := range mailboxes {
		out = append(out, Folder{Name: mb.Name, Delimiter: mb.Delimiter, Attributes: mb.Attributes})
	}
	if err := <-done; err != nil {
		return nil, ewrap(KindNetwork, fmt.Errorf("获取文件夹失败: %w", err))
	}
	return out, nil
}

func (c *imapClient) List(ctx context.Context, folder string, q Query) ([]Message, error) {
	if folder == "" {
		folder = "INBOX"
	}
	if _, err := c.c.Select(folder, true); err != nil {
		return nil, ewrap(KindNotFound, fmt.Errorf("打开文件夹 %s 失败: %w", folder, err))
	}
	crit := buildCriteria(q)
	if crit == nil {
		crit = &imap.SearchCriteria{} // ALL
	}
	uids, err := c.c.UidSearch(crit)
	if err != nil {
		return nil, ewrap(KindNetwork, fmt.Errorf("搜索失败: %w", err))
	}
	if len(uids) == 0 {
		return []Message{}, nil
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] > uids[j] })
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	if len(uids) > limit {
		uids = uids[:limit]
	}
	seq := new(imap.SeqSet)
	seq.AddNum(uids...)
	items := []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope, imap.FetchFlags, imap.FetchRFC822Size, imap.FetchInternalDate}
	messages := make(chan *imap.Message, 32)
	done := make(chan error, 1)
	go func() { done <- c.c.UidFetch(seq, items, messages) }()
	out := make([]Message, 0, len(uids))
	for m := range messages {
		out = append(out, messageFromFetch(m, folder))
	}
	if err := <-done; err != nil {
		return nil, ewrap(KindNetwork, fmt.Errorf("拉取邮件列表失败: %w", err))
	}
	sort.Slice(out, func(i, j int) bool {
		a, _ := strconv.ParseUint(out[i].ID, 10, 64)
		b, _ := strconv.ParseUint(out[j].ID, 10, 64)
		return a > b
	})
	return out, nil
}

func buildCriteria(q Query) *imap.SearchCriteria {
	cr := &imap.SearchCriteria{}
	empty := true
	if q.From != "" {
		cr.Header.Add("From", q.From)
		empty = false
	}
	if q.To != "" {
		cr.Header.Add("To", q.To)
		empty = false
	}
	if q.Subject != "" {
		cr.Header.Add("Subject", q.Subject)
		empty = false
	}
	if q.Text != "" {
		cr.Text = append(cr.Text, q.Text)
		empty = false
	}
	if q.Body != "" {
		cr.Body = append(cr.Body, q.Body)
		empty = false
	}
	if !q.Since.IsZero() {
		cr.Since = q.Since
		empty = false
	}
	if !q.Before.IsZero() {
		cr.Before = q.Before
		empty = false
	}
	if q.Unread != nil {
		if *q.Unread {
			cr.WithoutFlags = append(cr.WithoutFlags, imap.SeenFlag)
		} else {
			cr.WithFlags = append(cr.WithFlags, imap.SeenFlag)
		}
		empty = false
	}
	if q.Flagged != nil {
		if *q.Flagged {
			cr.WithFlags = append(cr.WithFlags, imap.FlaggedFlag)
		} else {
			cr.WithoutFlags = append(cr.WithoutFlags, imap.FlaggedFlag)
		}
		empty = false
	}
	if empty {
		return nil
	}
	return cr
}

func messageFromFetch(m *imap.Message, folder string) Message {
	msg := Message{
		ID:     strconv.FormatUint(uint64(m.Uid), 10),
		Folder: folder,
		Size:   int(m.Size),
		Unread: true,
	}
	for _, f := range m.Flags {
		switch strings.ToLower(f) {
		case strings.ToLower(imap.SeenFlag):
			msg.Unread = false
		case strings.ToLower(imap.FlaggedFlag):
			msg.Flagged = true
		case strings.ToLower(imap.AnsweredFlag):
			msg.Answered = true
		}
	}
	if m.Envelope != nil {
		env := m.Envelope
		msg.Subject = mailparse.DecodeHeader(env.Subject)
		msg.MessageID = env.MessageId
		if !env.Date.IsZero() {
			msg.Date = env.Date
		} else if !m.InternalDate.IsZero() {
			msg.Date = m.InternalDate
		}
		if len(env.From) > 0 {
			msg.From = addrString(env.From[0])
			msg.FromName = mailparse.DecodeHeader(env.From[0].PersonalName)
		}
		msg.To = addrStrings(env.To)
		msg.Cc = addrStrings(env.Cc)
	}
	return msg
}

func addrString(a *imap.Address) string {
	if a == nil {
		return ""
	}
	mail := a.MailboxName
	if a.HostName != "" {
		mail += "@" + a.HostName
	}
	return mail
}

func addrStrings(list []*imap.Address) []string {
	out := make([]string, 0, len(list))
	for _, a := range list {
		if a == nil {
			continue
		}
		name := mailparse.DecodeHeader(a.PersonalName)
		mail := addrString(a)
		if name != "" {
			out = append(out, fmt.Sprintf("%s <%s>", name, mail))
		} else {
			out = append(out, mail)
		}
	}
	return out
}

func (c *imapClient) Get(ctx context.Context, folder, id string) (*Message, error) {
	if folder == "" {
		folder = "INBOX"
	}
	fetched, raw, err := c.fetchRaw(ctx, folder, id)
	if err != nil {
		return nil, err
	}
	parsed, err := mailparse.Parse(raw, false)
	if err != nil {
		return nil, ewrap(KindGeneral, err)
	}
	msg := messageFromFetch(fetched, folder)
	msg.Subject = parsed.Subject
	msg.From = firstEmail(parsed.From)
	msg.FromName = firstName(parsed.From)
	msg.To = mailparse.FormatAddrs(parsed.To)
	msg.Cc = mailparse.FormatAddrs(parsed.Cc)
	msg.MessageID = parsed.MessageID
	msg.Text = parsed.Text
	msg.HTML = parsed.HTML
	if !parsed.Date.IsZero() {
		msg.Date = parsed.Date
	}
	for _, a := range parsed.Attachments {
		msg.Attachments = append(msg.Attachments, Attachment{
			Filename:    a.Filename,
			ContentType: a.ContentType,
			Size:        a.Size,
			Inline:      a.Inline,
		})
	}
	msg.HasAttachments = len(msg.Attachments) > 0
	msg.Size = len(raw)
	return &msg, nil
}

// fetchRaw 拉取整封原始邮件（PEEK 不改变已读状态）
func (c *imapClient) fetchRaw(ctx context.Context, folder, id string) (*imap.Message, []byte, error) {
	uid, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		return nil, nil, ewrap(KindConfig, fmt.Errorf("无效的邮件 ID: %s", id))
	}
	if _, err := c.c.Select(folder, true); err != nil {
		return nil, nil, ewrap(KindNotFound, fmt.Errorf("打开文件夹 %s 失败: %w", folder, err))
	}
	seq := new(imap.SeqSet)
	seq.AddNum(uint32(uid))
	section := &imap.BodySectionName{Peek: true}
	items := []imap.FetchItem{imap.FetchUid, imap.FetchFlags, imap.FetchEnvelope, imap.FetchInternalDate, imap.FetchRFC822Size, section.FetchItem()}
	messages := make(chan *imap.Message, 1)
	done := make(chan error, 1)
	go func() { done <- c.c.UidFetch(seq, items, messages) }()
	var fetched *imap.Message
	for m := range messages {
		fetched = m
	}
	if err := <-done; err != nil {
		return nil, nil, ewrap(KindNetwork, fmt.Errorf("拉取邮件失败: %w", err))
	}
	if fetched == nil {
		return nil, nil, ewrap(KindNotFound, fmt.Errorf("邮件不存在: %s", id))
	}
	r := fetched.GetBody(section)
	if r == nil {
		return nil, nil, ewrap(KindNotFound, fmt.Errorf("邮件正文为空: %s", id))
	}
	raw, err := io.ReadAll(io.LimitReader(r, maxRawMessage))
	if err != nil {
		return nil, nil, ewrap(KindNetwork, fmt.Errorf("读取邮件正文失败: %w", err))
	}
	return fetched, raw, nil
}

func (c *imapClient) SaveAttachments(ctx context.Context, folder, id, dir string) ([]Attachment, error) {
	if folder == "" {
		folder = "INBOX"
	}
	_, raw, err := c.fetchRaw(ctx, folder, id)
	if err != nil {
		return nil, err
	}
	parsed, err := mailparse.Parse(raw, true)
	if err != nil {
		return nil, ewrap(KindGeneral, err)
	}
	out := make([]Attachment, 0, len(parsed.Attachments))
	for _, a := range parsed.Attachments {
		path, err := writeAttachment(dir, a.Filename, a.Data)
		if err != nil {
			return out, ewrap(KindGeneral, err)
		}
		out = append(out, Attachment{Filename: a.Filename, ContentType: a.ContentType, Size: len(a.Data), SavedPath: path})
	}
	return out, nil
}

func firstEmail(list []mailparse.Address) string {
	if len(list) == 0 {
		return ""
	}
	return list[0].Email
}

func firstName(list []mailparse.Address) string {
	if len(list) == 0 {
		return ""
	}
	return list[0].Name
}

func (c *imapClient) Mark(ctx context.Context, folder string, ids []string, seen, flagged, answered *bool) error {
	if folder == "" {
		folder = "INBOX"
	}
	if len(ids) == 0 {
		return ewrap(KindConfig, fmt.Errorf("未指定邮件 ID"))
	}
	if _, err := c.c.Select(folder, false); err != nil {
		return ewrap(KindNotFound, fmt.Errorf("打开文件夹 %s 失败: %w", folder, err))
	}
	seq := new(imap.SeqSet)
	for _, id := range ids {
		n, err := strconv.ParseUint(id, 10, 32)
		if err != nil {
			return ewrap(KindConfig, fmt.Errorf("无效的邮件 ID: %s", id))
		}
		seq.AddNum(uint32(n))
	}
	apply := func(flag string, want bool) error {
		var op imap.FlagsOp = imap.AddFlags
		if !want {
			op = imap.RemoveFlags
		}
		item := imap.FormatFlagsOp(op, true)
		if err := c.c.UidStore(seq, item, []interface{}{flag}, nil); err != nil {
			return ewrap(KindNetwork, fmt.Errorf("更新标记失败: %w", err))
		}
		return nil
	}
	if seen != nil {
		if err := apply(imap.SeenFlag, *seen); err != nil {
			return err
		}
	}
	if flagged != nil {
		if err := apply(imap.FlaggedFlag, *flagged); err != nil {
			return err
		}
	}
	if answered != nil {
		if err := apply(imap.AnsweredFlag, *answered); err != nil {
			return err
		}
	}
	return nil
}

func (c *imapClient) Send(ctx context.Context, req SendRequest) (string, error) {
	atts, err := loadOutgoing(req.Attachments)
	if err != nil {
		return "", ewrap(KindConfig, err)
	}
	to, err := mailparse.ParseAddressInput(req.To)
	if err != nil {
		return "", ewrap(KindConfig, fmt.Errorf("收件人格式错误: %w", err))
	}
	cc, _ := mailparse.ParseAddressInput(req.Cc)
	bcc, _ := mailparse.ParseAddressInput(req.Bcc)
	if req.MessageID == "" {
		req.MessageID = mailparse.NewMessageID(c.acct.Email)
	}
	build := mailparse.BuildInput{
		From:        mailparse.Address{Name: c.acct.DisplayName, Email: c.acct.Email},
		To:          to,
		Cc:          cc,
		Subject:     req.Subject,
		Text:        req.Text,
		HTML:        req.HTML,
		Attachments: atts,
		InReplyTo:   req.InReplyTo,
		References:  req.References,
		MessageID:   req.MessageID,
	}
	raw, err := mailparse.Build(build)
	if err != nil {
		return "", ewrap(KindGeneral, err)
	}
	rcpts := emailsOf(to)
	rcpts = append(rcpts, emailsOf(cc)...)
	rcpts = append(rcpts, emailsOf(bcc)...)
	if len(rcpts) == 0 {
		return "", ewrap(KindConfig, fmt.Errorf("没有有效收件人"))
	}
	if err := sendSMTP(c.acct, c.det, raw, c.acct.Email, rcpts, c.timeout); err != nil {
		return "", err
	}
	c.appendSent(raw)
	return build.MessageID, nil
}

// appendSent 尽力保存到「已发送」，失败不影响发送结果
func (c *imapClient) appendSent(raw []byte) {
	folder := c.sentFolder()
	if folder == "" {
		return
	}
	_ = c.c.Append(folder, []string{imap.SeenFlag}, time.Now(), bytes.NewReader(raw))
}

func (c *imapClient) sentFolder() string {
	if c.acct.SentFolder != "" {
		return c.acct.SentFolder
	}
	mailboxes := make(chan *imap.MailboxInfo, 64)
	done := make(chan error, 1)
	go func() { done <- c.c.List("", "*", mailboxes) }()
	var fallback string
	for mb := range mailboxes {
		for _, a := range mb.Attributes {
			if strings.EqualFold(a, "\\Sent") {
				<-done
				return mb.Name
			}
		}
		lower := strings.ToLower(mb.Name)
		if fallback == "" && (strings.Contains(lower, "sent") || strings.Contains(mb.Name, "已发送")) {
			fallback = mb.Name
		}
	}
	<-done
	return fallback
}

func emailsOf(list []mailparse.Address) []string {
	out := make([]string, 0, len(list))
	for _, a := range list {
		out = append(out, a.Email)
	}
	return out
}
