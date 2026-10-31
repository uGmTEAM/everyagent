package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mailcli/internal/mailparse"
	"mailcli/internal/testutil"
)

// capture 捕获 Run 写入 stdout 的 JSON
func capture(t *testing.T, fn func() int) (string, int) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	code := fn()
	_ = w.Close()
	os.Stdout = old
	b, _ := io.ReadAll(r)
	return string(b), code
}

type envelope struct {
	OK   bool            `json:"ok"`
	Data json.RawMessage `json:"data"`
	Meta map[string]any  `json:"meta"`
	Err  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func TestCLIEndToEnd(t *testing.T) {
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

	raw, err := mailparse.Build(mailparse.BuildInput{
		From:    mailparse.Address{Name: "Alice", Email: "alice@example.com"},
		To:      []mailparse.Address{{Email: "me@example.com"}},
		Subject: "CLI 未读邮件",
		Text:    "CLI 正文",
	})
	if err != nil {
		t.Fatal(err)
	}
	uid := imapSrv.Seed(raw, false)

	host, port := imapSrv.Addr()
	_, smtpPort := smtpSrv.Addr()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	cfg := fmt.Sprintf(`default_account = "main"
timeout_seconds = 10
data_dir = "%s"

[accounts.main]
email = "me@example.com"
username = "me@example.com"
password = "secret"
display_name = "Me"
provider = "imap"
host = "%s"
port = %d
tls = "none"
smtp_host = "%s"
smtp_port = %d
smtp_tls = "none"
sent_folder = "Sent Messages"
`, filepath.Join(dir, "data"), host, port, host, smtpPort)
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	run := func(args ...string) (envelope, int) {
		full := append(args, "--config", cfgPath)
		out, code := capture(t, func() int { return Run(full) })
		var env envelope
		if err := json.Unmarshal([]byte(out), &env); err != nil {
			t.Fatalf("cmd %v -> invalid json %q (code=%d)", args, out, code)
		}
		return env, code
	}

	// accounts
	env, code := run("accounts")
	if code != 0 || !env.OK {
		t.Fatalf("accounts failed: code=%d out=%+v", code, env)
	}

	// unread
	env, code = run("unread")
	if code != 0 || !env.OK {
		t.Fatalf("unread failed: code=%d out=%+v", code, env)
	}
	var msgs []map[string]any
	if err := json.Unmarshal(env.Data, &msgs); err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0]["subject"] != "CLI 未读邮件" {
		t.Fatalf("msgs = %+v", msgs)
	}

	// read
	env, code = run("read", fmt.Sprintf("%d", uid))
	if code != 0 || !env.OK {
		t.Fatalf("read failed: code=%d out=%+v", code, env)
	}
	var msg map[string]any
	_ = json.Unmarshal(env.Data, &msg)
	if !strings.Contains(fmt.Sprint(msg["text"]), "CLI 正文") {
		t.Errorf("text = %v", msg["text"])
	}

	// send
	env, code = run("send", "--to", "bob@example.com", "--subject", "CLI 发送", "--text", "内容")
	if code != 0 || !env.OK {
		t.Fatalf("send failed: code=%d out=%+v", code, env)
	}
	if len(smtpSrv.Messages()) != 1 {
		t.Errorf("smtp messages = %d", len(smtpSrv.Messages()))
	}

	// mark seen
	env, code = run("mark", fmt.Sprintf("%d", uid), "--seen")
	if code != 0 || !env.OK {
		t.Fatalf("mark failed: code=%d out=%+v", code, env)
	}
	env, _ = run("unread")
	_ = json.Unmarshal(env.Data, &msgs)
	if len(msgs) != 0 {
		t.Errorf("unread after mark = %+v", msgs)
	}

	// log
	env, code = run("log")
	if code != 0 || !env.OK {
		t.Fatalf("log failed: code=%d", code)
	}
	var records []map[string]any
	_ = json.Unmarshal(env.Data, &records)
	if len(records) < 1 {
		t.Errorf("records = %+v", records)
	}

	// watch：首次建立基线，新邮件才产生事件
	if _, code = run("watch", "--once"); code != 0 {
		t.Fatalf("watch baseline failed: %d", code)
	}
	rawNew, err := mailparse.Build(mailparse.BuildInput{
		From:    mailparse.Address{Email: "new@example.com"},
		To:      []mailparse.Address{{Email: "me@example.com"}},
		Subject: "新到邮件",
		Text:    "新内容",
	})
	if err != nil {
		t.Fatal(err)
	}
	imapSrv.Seed(rawNew, true)
	out2, code := capture(t, func() int {
		return Run([]string{"watch", "--once", "--config", cfgPath})
	})
	if code != 0 {
		t.Fatalf("watch failed: %d, out=%s", code, out2)
	}
	if !strings.Contains(out2, `"type":"new_mail"`) || !strings.Contains(out2, "新到邮件") {
		t.Errorf("watch output = %s", out2)
	}
	lines := strings.Split(strings.TrimSpace(out2), "\n")
	var lastEnvelope envelope
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &lastEnvelope); err != nil || !lastEnvelope.OK {
		t.Errorf("watch summary invalid: %s", lines[len(lines)-1])
	}

	// 错误路径：缺 ID
	env, code = run("read")
	if code != 2 || env.OK || env.Err == nil || env.Err.Code != "usage" {
		t.Errorf("expected usage error, got code=%d env=%+v", code, env)
	}
}
