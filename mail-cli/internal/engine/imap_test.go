package engine

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"mailcli/internal/config"
	"mailcli/internal/detect"
	"mailcli/internal/mailparse"
	"mailcli/internal/store"
	"mailcli/internal/testutil"
)

func TestIMAPEndToEnd(t *testing.T) {
	imapSrv, err := testutil.NewIMAP()
	if err != nil {
		t.Fatal(err)
	}
	defer imapSrv.Close()
	smtpSrv, err := testutil.NewSMTP()
	if err != nil {
		t.Fatal(err)
	}
	defer smtpSrv.Close()

	raw1, err := mailparse.Build(mailparse.BuildInput{
		From:    mailparse.Address{Name: "Alice", Email: "alice@example.com"},
		To:      []mailparse.Address{{Name: "Me", Email: "me@example.com"}},
		Subject: "第一封未读邮件",
		Text:    "正文内容一",
		Attachments: []mailparse.OutgoingAttachment{
			{Filename: "notes.txt", Data: []byte("hello attachment")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw2, err := mailparse.Build(mailparse.BuildInput{
		From:    mailparse.Address{Email: "bob@example.com"},
		To:      []mailparse.Address{{Email: "me@example.com"}},
		Subject: "第二封已读邮件",
		Text:    "正文内容二",
	})
	if err != nil {
		t.Fatal(err)
	}
	uid1 := imapSrv.Seed(raw1, false)
	imapSrv.Seed(raw2, true)

	host, port := imapSrv.Addr()
	_, smtpPort := smtpSrv.Addr()
	acct := &config.Account{
		Email:       "me@example.com",
		Username:    "me@example.com",
		Password:    "secret",
		DisplayName: "测试账号",
		Host:        host,
		Port:        port,
		TLS:         "none",
		SMTPHost:    host,
		SMTPPort:    smtpPort,
		SMTPTLS:     "none",
		SentFolder:  "Sent Messages",
		Provider:    "imap",
	}
	det := &detect.Result{Provider: "imap", Host: host, Port: port, TLS: "none", SMTPHost: host, SMTPPort: smtpPort, SMTPTLS: "none"}
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	c, err := Open(ctx, Options{AccountName: "test", Account: acct, Det: det, Store: st, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer c.Close()

	folders, err := c.Folders(ctx)
	if err != nil {
		t.Fatalf("folders: %v", err)
	}
	if len(folders) != 2 {
		t.Errorf("folders = %+v", folders)
	}

	unread := true
	msgs, err := c.List(ctx, "INBOX", Query{Limit: 10, Unread: &unread})
	if err != nil {
		t.Fatalf("list unread: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("unread count = %d, msgs=%+v", len(msgs), msgs)
	}
	if msgs[0].Subject != "第一封未读邮件" {
		t.Errorf("subject = %q", msgs[0].Subject)
	}
	if msgs[0].From != "alice@example.com" || msgs[0].FromName != "Alice" {
		t.Errorf("from = %q %q", msgs[0].From, msgs[0].FromName)
	}

	msg, err := c.Get(ctx, "INBOX", strconv.FormatUint(uint64(uid1), 10))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !strings.Contains(msg.Text, "正文内容一") {
		t.Errorf("text = %q", msg.Text)
	}
	if len(msg.Attachments) != 1 || msg.Attachments[0].Filename != "notes.txt" {
		t.Errorf("attachments = %+v", msg.Attachments)
	}
	dir := t.TempDir()
	saved, err := c.SaveAttachments(ctx, "INBOX", strconv.FormatUint(uint64(uid1), 10), dir)
	if err != nil {
		t.Fatalf("save attachments: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("saved = %+v", saved)
	}
	data, err := os.ReadFile(filepath.Join(dir, "notes.txt"))
	if err != nil || string(data) != "hello attachment" {
		t.Errorf("attachment file = %q err=%v", data, err)
	}

	seen := true
	if err := c.Mark(ctx, "INBOX", []string{strconv.FormatUint(uint64(uid1), 10)}, &seen, nil, nil); err != nil {
		t.Fatalf("mark: %v", err)
	}
	msgs, err = c.List(ctx, "INBOX", Query{Limit: 10, Unread: &unread})
	if err != nil {
		t.Fatalf("list unread after mark: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("still unread: %+v", msgs)
	}

	id, err := c.Send(ctx, SendRequest{
		To:      []string{"bob@example.com"},
		Cc:      []string{"carol@example.com"},
		Subject: "测试发送",
		Text:    "发送正文",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if id == "" {
		t.Error("empty message id")
	}
	sent := smtpSrv.Messages()
	if len(sent) != 1 {
		t.Fatalf("smtp messages = %d", len(sent))
	}
	parsed, err := mailparse.Parse(sent[0], false)
	if err != nil {
		t.Fatalf("parse sent: %v", err)
	}
	if parsed.Subject != "测试发送" || !strings.Contains(parsed.Text, "发送正文") {
		t.Errorf("sent parsed subject=%q text=%q", parsed.Subject, parsed.Text)
	}
	if imapSrv.Appended() != 1 {
		t.Errorf("appended = %d", imapSrv.Appended())
	}
}

func TestIMAPAuthFailure(t *testing.T) {
	imapSrv, err := testutil.NewIMAP()
	if err != nil {
		t.Fatal(err)
	}
	defer imapSrv.Close()
	host, port := imapSrv.Addr()
	acct := &config.Account{Email: "a@b.com", Username: "a@b.com", Password: "badpass", Host: host, Port: port, Provider: "imap"}
	acct.TLS = "none"
	det := &detect.Result{Provider: "imap", Host: host, Port: port, TLS: "none"}
	st, _ := store.Open(t.TempDir())
	_, err = Open(context.Background(), Options{AccountName: "x", Account: acct, Det: det, Store: st, Timeout: 5 * time.Second})
	if err == nil {
		t.Fatal("expected auth failure")
	}
	if KindOf(err) != KindAuth {
		t.Errorf("kind = %v, err = %v", KindOf(err), err)
	}
}
