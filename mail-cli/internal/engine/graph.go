package engine

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
	"time"

	"mailcli/internal/mailparse"
	"mailcli/internal/oauth"
)

type graphClient struct {
	apiClient
}

type gRecipient struct {
	EmailAddress struct {
		Name    string `json:"name"`
		Address string `json:"address"`
	} `json:"emailAddress"`
}

type gBody struct {
	ContentType string `json:"contentType"`
	Content     string `json:"content"`
}

type gFlag struct {
	FlagStatus string `json:"flagStatus"`
}

type gMessage struct {
	ID                string       `json:"id"`
	Subject           string       `json:"subject"`
	BodyPreview       string       `json:"bodyPreview"`
	InternetMessageID string       `json:"internetMessageID"`
	ReceivedDateTime  time.Time    `json:"receivedDateTime"`
	IsRead            bool         `json:"isRead"`
	HasAttachments    bool         `json:"hasAttachments"`
	Body              *gBody       `json:"body"`
	From              *gRecipient  `json:"from"`
	ToRecipients      []gRecipient `json:"toRecipients"`
	CcRecipients      []gRecipient `json:"ccRecipients"`
	Flag              *gFlag       `json:"flag"`
}

type gAttachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int    `json:"size"`
	IsInline    bool   `json:"isInline"`
}

const graphSelect = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,internetMessageID,flag"

func newGraph(ctx context.Context, o Options) (*graphClient, error) {
	base := o.Account.APIBase
	if base == "" {
		base = "https://graph.microsoft.com/v1.0"
	}
	c := &graphClient{apiClient: apiClient{
		provider: "graph",
		acct:     o.Account,
		name:     o.AccountName,
		st:       o.Store,
		ep:       oauth.EndpointsFor("graph", o.Account),
		base:     strings.TrimRight(base, "/"),
		timeout:  o.Timeout,
	}}
	if _, err := c.token(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *graphClient) Provider() string { return "graph" }
func (c *graphClient) Close() error     { return nil }

func (c *graphClient) Folders(ctx context.Context) ([]Folder, error) {
	var resp struct {
		Value []struct {
			ID              string `json:"id"`
			DisplayName     string `json:"displayName"`
			TotalItemCount  int    `json:"totalItemCount"`
			UnreadItemCount int    `json:"unreadItemCount"`
		} `json:"value"`
	}
	path := "/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount"
	if err := c.do(ctx, "GET", path, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]Folder, 0, len(resp.Value))
	for _, f := range resp.Value {
		out = append(out, Folder{Name: f.DisplayName, Messages: uint32(f.TotalItemCount), Unread: uint32(f.UnreadItemCount)})
	}
	return out, nil
}

func folderID(folder string) string {
	f := strings.TrimSpace(folder)
	if f == "" {
		return "inbox"
	}
	switch strings.ToLower(f) {
	case "inbox", "sent", "sentitems", "drafts", "deleteditems", "junkemail", "archive", "outbox":
		return strings.ToLower(f)
	}
	return f
}

func (c *graphClient) List(ctx context.Context, folder string, q Query) ([]Message, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	var path string
	if search := graphSearch(q); search != "" {
		path = fmt.Sprintf("/me/messages?$top=%d&$select=%s&$search=%s", limit, graphSelect, url.QueryEscape(search))
	} else {
		path = fmt.Sprintf("/me/mailFolders/%s/messages?$top=%d&$orderby=%s&$select=%s",
			url.PathEscape(folderID(folder)), limit, url.QueryEscape("receivedDateTime desc"), graphSelect)
		if filter := graphFilter(q); filter != "" {
			path += "&$filter=" + url.QueryEscape(filter)
		}
	}
	var resp struct {
		Value []gMessage `json:"value"`
	}
	if err := c.do(ctx, "GET", path, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(resp.Value))
	for _, m := range resp.Value {
		out = append(out, *messageFromGraph(&m, folderID(folder)))
	}
	return out, nil
}

func messageFromGraph(g *gMessage, folder string) *Message {
	msg := &Message{
		ID:             g.ID,
		Folder:         folder,
		Subject:        g.Subject,
		Snippet:        g.BodyPreview,
		Date:           g.ReceivedDateTime,
		Unread:         !g.IsRead,
		HasAttachments: g.HasAttachments,
		MessageID:      g.InternetMessageID,
	}
	if g.Flag != nil && strings.EqualFold(g.Flag.FlagStatus, "flagged") {
		msg.Flagged = true
	}
	if g.From != nil {
		msg.From = g.From.EmailAddress.Address
		msg.FromName = g.From.EmailAddress.Name
	}
	for _, r := range g.ToRecipients {
		msg.To = append(msg.To, formatRecipient(r))
	}
	for _, r := range g.CcRecipients {
		msg.Cc = append(msg.Cc, formatRecipient(r))
	}
	if g.Body != nil {
		if strings.EqualFold(g.Body.ContentType, "html") {
			msg.HTML = g.Body.Content
			msg.Text = mailparse.HTMLToText(g.Body.Content)
		} else {
			msg.Text = g.Body.Content
		}
	}
	return msg
}

func formatRecipient(r gRecipient) string {
	if r.EmailAddress.Name != "" {
		return fmt.Sprintf("%s <%s>", r.EmailAddress.Name, r.EmailAddress.Address)
	}
	return r.EmailAddress.Address
}

func graphSearch(q Query) string {
	parts := []string{}
	if q.From != "" {
		parts = append(parts, "from:"+quoteIfSpace(q.From))
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
	if q.To != "" {
		parts = append(parts, "to:"+quoteIfSpace(q.To))
	}
	return strings.Join(parts, " ")
}

func graphFilter(q Query) string {
	var conds []string
	if q.Unread != nil {
		if *q.Unread {
			conds = append(conds, "isRead eq false")
		} else {
			conds = append(conds, "isRead eq true")
		}
	}
	if !q.Since.IsZero() {
		conds = append(conds, "receivedDateTime ge "+q.Since.UTC().Format("2006-01-02T15:04:05Z"))
	}
	if !q.Before.IsZero() {
		conds = append(conds, "receivedDateTime lt "+q.Before.UTC().Format("2006-01-02T15:04:05Z"))
	}
	return strings.Join(conds, " and ")
}

func (c *graphClient) Get(ctx context.Context, folder, id string) (*Message, error) {
	path := "/me/messages/" + url.PathEscape(id) +
		"?$select=id,subject,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,internetMessageID,flag"
	var gm gMessage
	if err := c.do(ctx, "GET", path, nil, &gm); err != nil {
		return nil, err
	}
	msg := messageFromGraph(&gm, folderID(folder))
	atts, err := c.listAttachments(ctx, id)
	if err == nil {
		for _, a := range atts {
			msg.Attachments = append(msg.Attachments, Attachment{
				Filename:    a.Name,
				ContentType: a.ContentType,
				Size:        a.Size,
				Inline:      a.IsInline,
				PartID:      a.ID,
			})
		}
		msg.HasAttachments = len(msg.Attachments) > 0
	}
	return msg, nil
}

func (c *graphClient) listAttachments(ctx context.Context, id string) ([]gAttachment, error) {
	var resp struct {
		Value []gAttachment `json:"value"`
	}
	path := "/me/messages/" + url.PathEscape(id) + "/attachments?$select=id,name,contentType,size,isInline"
	if err := c.do(ctx, "GET", path, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Value, nil
}

func (c *graphClient) Mark(ctx context.Context, folder string, ids []string, seen, flagged, answered *bool) error {
	for _, id := range ids {
		patch := map[string]any{}
		if seen != nil {
			patch["isRead"] = *seen
		}
		if flagged != nil {
			status := "notFlagged"
			if *flagged {
				status = "flagged"
			}
			patch["flag"] = map[string]string{"flagStatus": status}
		}
		if len(patch) == 0 {
			continue
		}
		if err := c.do(ctx, "PATCH", "/me/messages/"+url.PathEscape(id), patch, nil); err != nil {
			return err
		}
	}
	return nil
}

func (c *graphClient) SaveAttachments(ctx context.Context, folder, id, dir string) ([]Attachment, error) {
	atts, err := c.listAttachments(ctx, id)
	if err != nil {
		return nil, err
	}
	var saved []Attachment
	for _, a := range atts {
		data, err := c.getRaw(ctx, "/me/messages/"+url.PathEscape(id)+"/attachments/"+url.PathEscape(a.ID)+"/$value")
		if err != nil {
			return saved, err
		}
		path, err := writeAttachment(dir, a.Name, data)
		if err != nil {
			return saved, err
		}
		saved = append(saved, Attachment{Filename: a.Name, ContentType: a.ContentType, Size: len(data), SavedPath: path})
	}
	return saved, nil
}

func (c *graphClient) Send(ctx context.Context, req SendRequest) (string, error) {
	to, err := mailparse.ParseAddressInput(req.To)
	if err != nil {
		return "", ewrap(KindConfig, fmt.Errorf("收件人格式错误: %w", err))
	}
	cc, _ := mailparse.ParseAddressInput(req.Cc)
	bcc, _ := mailparse.ParseAddressInput(req.Bcc)
	if len(to)+len(cc)+len(bcc) == 0 {
		return "", ewrap(KindConfig, fmt.Errorf("没有有效收件人"))
	}
	bodyType := "Text"
	content := req.Text
	if req.HTML != "" {
		bodyType = "HTML"
		content = req.HTML
	}
	msg := map[string]any{
		"subject":      req.Subject,
		"body":         map[string]string{"contentType": bodyType, "content": content},
		"toRecipients": recipientsJSON(to),
	}
	if len(cc) > 0 {
		msg["ccRecipients"] = recipientsJSON(cc)
	}
	if len(bcc) > 0 {
		msg["bccRecipients"] = recipientsJSON(bcc)
	}
	if req.InReplyTo != "" {
		msg["internetMessageHeaders"] = []map[string]string{
			{"name": "In-Reply-To", "value": req.InReplyTo},
		}
	}
	if len(req.Attachments) > 0 {
		atts, err := loadOutgoing(req.Attachments)
		if err != nil {
			return "", ewrap(KindConfig, err)
		}
		var list []map[string]any
		for _, a := range atts {
			list = append(list, map[string]any{
				"@odata.type":  "#microsoft.graph.fileAttachment",
				"name":         a.Filename,
				"contentType":  a.ContentType,
				"contentBytes": base64.StdEncoding.EncodeToString(a.Data),
			})
		}
		msg["attachments"] = list
	}
	payload := map[string]any{"message": msg, "saveToSentItems": true}
	if err := c.do(ctx, "POST", "/me/sendMail", payload, nil); err != nil {
		return "", err
	}
	return mailparse.NewMessageID(c.acct.Email), nil
}

func recipientsJSON(list []mailparse.Address) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, a := range list {
		out = append(out, map[string]any{
			"emailAddress": map[string]string{"address": a.Email, "name": a.Name},
		})
	}
	return out
}

var _ = oauth.Token{}
