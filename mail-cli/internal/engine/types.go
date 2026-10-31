package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mailcli/internal/config"
	"mailcli/internal/detect"
	"mailcli/internal/mailparse"
	"mailcli/internal/store"
)

type Folder struct {
	Name       string   `json:"name"`
	Delimiter  string   `json:"delimiter,omitempty"`
	Attributes []string `json:"attributes,omitempty"`
	Messages   uint32   `json:"messages,omitempty"`
	Unread     uint32   `json:"unread,omitempty"`
}

type Attachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int    `json:"size"`
	Inline      bool   `json:"inline,omitempty"`
	PartID      string `json:"part_id,omitempty"`
	SavedPath   string `json:"saved_path,omitempty"`
}

type Message struct {
	ID             string       `json:"id"`
	Folder         string       `json:"folder,omitempty"`
	Subject        string       `json:"subject"`
	From           string       `json:"from"`
	FromName       string       `json:"from_name,omitempty"`
	To             []string     `json:"to,omitempty"`
	Cc             []string     `json:"cc,omitempty"`
	Date           time.Time    `json:"date"`
	Unread         bool         `json:"unread"`
	Flagged        bool         `json:"flagged"`
	Answered       bool         `json:"answered,omitempty"`
	HasAttachments bool         `json:"has_attachments"`
	Snippet        string       `json:"snippet,omitempty"`
	Size           int          `json:"size,omitempty"`
	MessageID      string       `json:"message_id,omitempty"`
	Text           string       `json:"text,omitempty"`
	HTML           string       `json:"html,omitempty"`
	Attachments    []Attachment `json:"attachments,omitempty"`
}

type Query struct {
	From    string
	To      string
	Subject string
	Body    string
	Text    string
	Since   time.Time
	Before  time.Time
	Unread  *bool
	Flagged *bool
	Limit   int
	Folder  string
}

type SendRequest struct {
	To          []string
	Cc          []string
	Bcc         []string
	Subject     string
	Text        string
	HTML        string
	Attachments []string
	InReplyTo   string
	References  string
	MessageID   string
}

type GetOptions struct {
	WithAttachments bool
}

type Client interface {
	Provider() string
	Folders(ctx context.Context) ([]Folder, error)
	List(ctx context.Context, folder string, q Query) ([]Message, error)
	Get(ctx context.Context, folder, id string) (*Message, error)
	SaveAttachments(ctx context.Context, folder, id, dir string) ([]Attachment, error)
	Mark(ctx context.Context, folder string, ids []string, seen, flagged, answered *bool) error
	Send(ctx context.Context, req SendRequest) (string, error)
	Close() error
}

type Options struct {
	AccountName string
	Account     *config.Account
	Det         *detect.Result
	Store       *store.Store
	Timeout     time.Duration
}

// 错误分类，CLI 据此映射退出码
type Kind int

const (
	KindGeneral Kind = iota
	KindAuth
	KindNetwork
	KindNotFound
	KindConfig
)

type Error struct {
	Kind Kind
	Err  error
}

func (e *Error) Error() string { return e.Err.Error() }
func (e *Error) Unwrap() error { return e.Err }

func ewrap(k Kind, err error) error {
	if err == nil {
		return nil
	}
	var exist *Error
	if errors.As(err, &exist) {
		return err
	}
	return &Error{Kind: k, Err: err}
}

func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return KindGeneral
}

func Open(ctx context.Context, o Options) (Client, error) {
	if o.Timeout <= 0 {
		o.Timeout = 30 * time.Second
	}
	switch o.Det.Provider {
	case "gmail":
		return newGmail(ctx, o)
	case "graph":
		return newGraph(ctx, o)
	case "imap", "":
		return newIMAP(ctx, o)
	}
	return nil, ewrap(KindConfig, fmt.Errorf("不支持的 provider: %s", o.Det.Provider))
}

// ReplyAddress 生成 "Name <mail>" 形式
func ReplyAddress(a *config.Account) string {
	if a.DisplayName == "" {
		return a.Email
	}
	return fmt.Sprintf("%s <%s>", a.DisplayName, a.Email)
}

func loadOutgoing(paths []string) ([]mailparse.OutgoingAttachment, error) {
	out := make([]mailparse.OutgoingAttachment, 0, len(paths))
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("附件不存在: %s", p)
		}
		if st.IsDir() {
			entries, err := os.ReadDir(p)
			if err != nil {
				return nil, err
			}
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				att, err := readFileAttachment(filepath.Join(p, e.Name()))
				if err != nil {
					return nil, err
				}
				out = append(out, att)
			}
			continue
		}
		att, err := readFileAttachment(p)
		if err != nil {
			return nil, err
		}
		out = append(out, att)
	}
	return out, nil
}

func readFileAttachment(p string) (mailparse.OutgoingAttachment, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return mailparse.OutgoingAttachment{}, err
	}
	if len(b) > 25<<20 {
		return mailparse.OutgoingAttachment{}, fmt.Errorf("附件过大(>25MB): %s", p)
	}
	return mailparse.OutgoingAttachment{Filename: filepath.Base(p), Data: b}, nil
}

// writeAttachment 落盘附件，处理非法字符与重名
func writeAttachment(dir, name string, data []byte) (string, error) {
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name = safeFilename(name)
	target := filepath.Join(dir, name)
	if _, err := os.Stat(target); err == nil {
		ext := filepath.Ext(name)
		base := strings.TrimSuffix(name, ext)
		for i := 1; i < 1000; i++ {
			alt := filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i, ext))
			if _, err := os.Stat(alt); os.IsNotExist(err) {
				target = alt
				break
			}
		}
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", err
	}
	return target, nil
}

func safeFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	bad := []string{"/", "\\", ":", "*", "?", "\"", "<", ">", "|", "\x00"}
	for _, b := range bad {
		name = strings.ReplaceAll(name, b, "_")
	}
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "attachment"
	}
	return name
}
