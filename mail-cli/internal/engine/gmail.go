package engine

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"

	"mailcli/internal/mailparse"
	"mailcli/internal/oauth"
)

type gmailClient struct {
	apiClient
}

type gmailPart struct {
	PartID   string `json:"partId"`
	MimeType string `json:"mimeType"`
	Filename string `json:"filename"`
	Headers  []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"headers"`
	Body struct {
		AttachmentID string `json:"attachmentId"`
		Size         int    `json:"size"`
		Data         string `json:"data"`
	} `json:"body"`
	Parts []gmailPart `json:"parts"`
}

type gmailMessage struct {
	ID           string     `json:"id"`
	ThreadID     string     `json:"threadId"`
	LabelIDs     []string   `json:"labelIds"`
	Snippet      string     `json:"snippet"`
	InternalDate string     `json:"internalDate"`
	SizeEstimate int        `json:"sizeEstimate"`
	Payload      *gmailPart `json:"payload"`
	Raw          string     `json:"raw"`
}

func newGmail(ctx context.Context, o Options) (*gmailClient, error) {
	base := o.Account.APIBase
	if base == "" {
		base = "https://gmail.googleapis.com/gmail/v1"
	}
	c := &gmailClient{apiClient: apiClient{
		provider: "gmail",
		acct:     o.Account,
		name:     o.AccountName,
		st:       o.Store,
		ep:       oauth.EndpointsFor("gmail", o.Account),
		base:     strings.TrimRight(base, "/"),
		timeout:  o.Timeout,
	}}
	if _, err := c.token(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *gmailClient) Provider() string { return "gmail" }
func (c *gmailClient) Close() error     { return nil }

func (c *gmailClient) Folders(ctx context.Context) ([]Folder, error) {
	var resp struct {
		Labels []struct {
			ID             string `json:"id"`
			Name           string `json:"name"`
			Type           string `json:"type"`
			MessagesTotal  int    `json:"messagesTotal"`
			MessagesUnread int    `json:"messagesUnread"`
		} `json:"labels"`
	}
	if err := c.do(ctx, "GET", "/users/me/labels", nil, &resp); err != nil {
		return nil, err
	}
	out := make([]Folder, 0, len(resp.Labels))
	for _, l := range resp.Labels {
		out = append(out, Folder{Name: l.Name, Messages: uint32(l.MessagesTotal), Unread: uint32(l.MessagesUnread)})
	}
	return out, nil
}

func (c *gmailClient) List(ctx context.Context, folder string, q Query) ([]Message, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	path := fmt.Sprintf("/users/me/messages?maxResults=%d", limit)
	if query := gmailQuery(folder, q); query != "" {
		path += "&q=" + url.QueryEscape(query)
	}
	var resp struct {
		Messages []struct {
			ID       string `json:"id"`
			ThreadID string `json:"threadId"`
		} `json:"messages"`
	}
	if err := c.do(ctx, "GET", path, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(resp.Messages))
	for _, m := range resp.Messages {
		msg, err := c.fetchMetadata(ctx, m.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, *msg)
	}
	return out, nil
}

func (c *gmailClient) fetchMetadata(ctx context.Context, id string) (*Message, error) {
	path := "/users/me/messages/" + url.PathEscape(id) +
		"?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Message-Id"
	var gm gmailMessage
	if err := c.do(ctx, "GET", path, nil, &gm); err != nil {
		return nil, err
	}
	msg := &Message{ID: gm.ID, Folder: "INBOX", Snippet: gm.Snippet, Size: gm.SizeEstimate}
	hdr := map[string]string{}
	if gm.Payload != nil {
		for _, h := range gm.Payload.Headers {
			hdr[strings.ToLower(h.Name)] = h.Value
		}
		for _, p := range gm.Payload.Parts {
			if p.Filename != "" {
				msg.HasAttachments = true
			}
		}
		if gm.Payload.Filename != "" {
			msg.HasAttachments = true
		}
	}
	msg.Subject = mailparse.DecodeHeader(hdr["subject"])
	msg.MessageID = strings.TrimSpace(hdr["message-id"])
	msg.From, msg.FromName = parseSingleAddress(hdr["from"])
	msg.To = parseAddressStrings(hdr["to"])
	msg.Cc = parseAddressStrings(hdr["cc"])
	if d, err := mail.ParseDate(hdr["date"]); err == nil {
		msg.Date = d
	} else if gm.InternalDate != "" {
		if ms, err := strconv.ParseInt(gm.InternalDate, 10, 64); err == nil {
			msg.Date = time.UnixMilli(ms)
		}
	}
	for _, l := range gm.LabelIDs {
		if l == "UNREAD" {
			msg.Unread = true
		}
		if l == "STARRED" {
			msg.Flagged = true
		}
	}
	for _, l := range gm.LabelIDs {
		if l == "INBOX" {
			msg.Folder = "INBOX"
		}
	}
	if msg.Folder == "" {
		msg.Folder = "INBOX"
	}
	return msg, nil
}

func (c *gmailClient) Get(ctx context.Context, folder, id string) (*Message, error) {
	path := "/users/me/messages/" + url.PathEscape(id) + "?format=full"
	var gm gmailMessage
	if err := c.do(ctx, "GET", path, nil, &gm); err != nil {
		return nil, err
	}
	msg := &Message{ID: gm.ID, Folder: folder, Snippet: gm.Snippet, Size: gm.SizeEstimate}
	if msg.Folder == "" {
		msg.Folder = "INBOX"
	}
	for _, l := range gm.LabelIDs {
		switch l {
		case "UNREAD":
			msg.Unread = true
		case "STARRED":
			msg.Flagged = true
		}
	}
	if gm.InternalDate != "" {
		if ms, err := strconv.ParseInt(gm.InternalDate, 10, 64); err == nil {
			msg.Date = time.UnixMilli(ms)
		}
	}
	if gm.Payload != nil {
		collectGmailParts(gm.Payload, msg)
	}
	if msg.Text == "" && msg.HTML != "" {
		msg.Text = mailparse.HTMLToText(msg.HTML)
	}
	return msg, nil
}

// SaveAttachments 逐个下载附件到指定目录
func (c *gmailClient) SaveAttachments(ctx context.Context, folder, id, dir string) ([]Attachment, error) {
	path := "/users/me/messages/" + url.PathEscape(id) + "?format=full"
	var gm gmailMessage
	if err := c.do(ctx, "GET", path, nil, &gm); err != nil {
		return nil, err
	}
	var parts []*gmailPart
	if gm.Payload != nil {
		collectGmailAttachmentParts(gm.Payload, &parts)
	}
	out := make([]Attachment, 0, len(parts))
	for _, p := range parts {
		if p.Body.AttachmentID == "" {
			continue
		}
		data, err := c.downloadAttachment(ctx, gm.ID, p.Body.AttachmentID)
		if err != nil {
			return out, err
		}
		saved, err := writeAttachment(dir, p.Filename, data)
		if err != nil {
			return out, ewrap(KindGeneral, err)
		}
		out = append(out, Attachment{Filename: p.Filename, ContentType: p.MimeType, Size: len(data), SavedPath: saved})
	}
	return out, nil
}

func collectGmailAttachmentParts(p *gmailPart, out *[]*gmailPart) {
	for i := range p.Parts {
		child := &p.Parts[i]
		if child.Filename != "" && child.Body.AttachmentID != "" {
			*out = append(*out, child)
		}
		collectGmailAttachmentParts(child, out)
	}
}

func collectGmailParts(p *gmailPart, msg *Message) {
	for _, h := range p.Headers {
		switch strings.ToLower(h.Name) {
		case "subject":
			if msg.Subject == "" {
				msg.Subject = mailparse.DecodeHeader(h.Value)
			}
		case "from":
			if msg.From == "" {
				msg.From, msg.FromName = parseSingleAddress(h.Value)
			}
		case "to":
			msg.To = parseAddressStrings(h.Value)
		case "cc":
			msg.Cc = parseAddressStrings(h.Value)
		case "date":
			if d, err := mail.ParseDate(h.Value); err == nil {
				msg.Date = d
			}
		case "message-id":
			msg.MessageID = strings.TrimSpace(h.Value)
		}
	}
	if p.Filename != "" {
		msg.Attachments = append(msg.Attachments, Attachment{
			Filename:    p.Filename,
			ContentType: p.MimeType,
			Size:        p.Body.Size,
			PartID:      p.PartID,
		})
		msg.HasAttachments = true
		return
	}
	switch p.MimeType {
	case "text/plain":
		if msg.Text == "" && p.Body.Data != "" {
			msg.Text = decodeB64URL(p.Body.Data)
		}
	case "text/html":
		if msg.HTML == "" && p.Body.Data != "" {
			msg.HTML = decodeB64URL(p.Body.Data)
		}
	}
	for i := range p.Parts {
		collectGmailParts(&p.Parts[i], msg)
	}
}

func (c *gmailClient) downloadAttachment(ctx context.Context, msgID, attID string) ([]byte, error) {
	path := "/users/me/messages/" + url.PathEscape(msgID) + "/attachments/" + url.PathEscape(attID)
	var resp struct {
		Data string `json:"data"`
		Size int    `json:"size"`
	}
	if err := c.do(ctx, "GET", path, nil, &resp); err != nil {
		return nil, err
	}
	return decodeB64URLBytes(resp.Data), nil
}

func (c *gmailClient) Mark(ctx context.Context, folder string, ids []string, seen, flagged, answered *bool) error {
	for _, id := range ids {
		body := map[string][]string{}
		if seen != nil {
			if *seen {
				body["removeLabelIds"] = append(body["removeLabelIds"], "UNREAD")
			} else {
				body["addLabelIds"] = append(body["addLabelIds"], "UNREAD")
			}
		}
		if flagged != nil {
			if *flagged {
				body["addLabelIds"] = append(body["addLabelIds"], "STARRED")
			} else {
				body["removeLabelIds"] = append(body["removeLabelIds"], "STARRED")
			}
		}
		if len(body) == 0 {
			continue
		}
		path := "/users/me/messages/" + url.PathEscape(id) + "/modify"
		if err := c.do(ctx, "POST", path, body, nil); err != nil {
			return err
		}
	}
	return nil
}

func (c *gmailClient) Send(ctx context.Context, req SendRequest) (string, error) {
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
	body := map[string]string{"raw": base64.RawURLEncoding.EncodeToString(raw)}
	if len(bcc) > 0 {
		// Gmail API 需要显式 Bcc 头，已在 Build 中省略，这里补一个 envelope 提示
		body["raw"] = base64.RawURLEncoding.EncodeToString(withBccHeader(raw, bcc))
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := c.do(ctx, "POST", "/users/me/messages/send", body, &resp); err != nil {
		return "", err
	}
	if resp.ID != "" {
		return resp.ID, nil
	}
	return build.MessageID, nil
}

func withBccHeader(raw []byte, bcc []mailparse.Address) []byte {
	idx := strings.Index(string(raw), "\r\n\r\n")
	if idx < 0 {
		return raw
	}
	header := "Bcc: " + strings.Join(mailparse.FormatAddrs(bcc), ", ") + "\r\n"
	return append(append([]byte{}, raw[:idx+2]...), append([]byte(header), raw[idx+2:]...)...)
}

func gmailQuery(folder string, q Query) string {
	parts := []string{}
	if folder == "" || strings.EqualFold(folder, "INBOX") {
		parts = append(parts, "in:inbox")
	} else {
		parts = append(parts, "label:"+quoteIfSpace(folder))
	}
	if q.Unread != nil {
		if *q.Unread {
			parts = append(parts, "is:unread")
		} else {
			parts = append(parts, "is:read")
		}
	}
	if q.Flagged != nil && *q.Flagged {
		parts = append(parts, "is:starred")
	}
	if q.From != "" {
		parts = append(parts, "from:"+quoteIfSpace(q.From))
	}
	if q.To != "" {
		parts = append(parts, "to:"+quoteIfSpace(q.To))
	}
	if q.Subject != "" {
		parts = append(parts, "subject:"+quoteIfSpace(q.Subject))
	}
	if q.Text != "" {
		parts = append(parts, quoteIfSpace(q.Text))
	}
	if q.Body != "" {
		parts = append(parts, quoteIfSpace(q.Body))
	}
	if !q.Since.IsZero() {
		parts = append(parts, "after:"+q.Since.Format("2006/01/02"))
	}
	if !q.Before.IsZero() {
		parts = append(parts, "before:"+q.Before.Format("2006/01/02"))
	}
	return strings.Join(parts, " ")
}

func quoteIfSpace(s string) string {
	if strings.ContainsAny(s, " \t") {
		return `"` + strings.ReplaceAll(s, `"`, "") + `"`
	}
	return s
}

func decodeB64URL(s string) string { return string(decodeB64URLBytes(s)) }

func decodeB64URLBytes(s string) []byte {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b
	}
	return nil
}

func parseSingleAddress(s string) (string, string) {
	decoded := mailparse.DecodeHeader(s)
	if decoded == "" {
		return "", ""
	}
	if a, err := mail.ParseAddress(decoded); err == nil {
		return a.Address, a.Name
	}
	return decoded, ""
}

func parseAddressStrings(s string) []string {
	decoded := mailparse.DecodeHeader(s)
	if strings.TrimSpace(decoded) == "" {
		return nil
	}
	list, err := mail.ParseAddressList(decoded)
	if err != nil {
		return []string{decoded}
	}
	out := make([]string, 0, len(list))
	for _, a := range list {
		if a.Name != "" {
			out = append(out, fmt.Sprintf("%s <%s>", a.Name, a.Address))
		} else {
			out = append(out, a.Address)
		}
	}
	return out
}
