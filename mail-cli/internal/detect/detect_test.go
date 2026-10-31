package detect

import (
	"context"
	"testing"

	"mailcli/internal/config"
)

func TestDetectKnownDomains(t *testing.T) {
	cases := []struct {
		email string
		host  string
		port  int
	}{
		{"a@qq.com", "imap.qq.com", 993},
		{"a@163.com", "imap.163.com", 993},
		{"a@126.com", "imap.126.com", 993},
		{"a@aliyun.com", "imap.qiye.aliyun.com", 993},
		{"a@outlook.com", "outlook.office365.com", 993},
		{"a@icloud.com", "imap.mail.me.com", 993},
	}
	for _, c := range cases {
		res, err := Detect(context.Background(), &config.Account{Email: c.email}, Options{})
		if err != nil {
			t.Fatalf("%s: %v", c.email, err)
		}
		if res.Provider != "imap" {
			t.Errorf("%s provider = %s", c.email, res.Provider)
		}
		if res.Host != c.host || res.Port != c.port {
			t.Errorf("%s host = %s:%d, want %s:%d", c.email, res.Host, res.Port, c.host, c.port)
		}
		if res.SMTPHost == "" {
			t.Errorf("%s missing smtp", c.email)
		}
	}
}

func TestDetectOAuthGmail(t *testing.T) {
	a := &config.Account{Email: "me@gmail.com", ClientID: "cid", RefreshToken: "rt", Provider: "auto"}
	a.TLS = "ssl"
	res, err := Detect(context.Background(), a, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Provider != "gmail" {
		t.Errorf("provider = %s", res.Provider)
	}
}

func TestDetectOAuthGraph(t *testing.T) {
	a := &config.Account{Email: "me@outlook.com", ClientID: "cid", RefreshToken: "rt", Provider: "auto"}
	a.TLS = "ssl"
	res, err := Detect(context.Background(), a, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Provider != "graph" {
		t.Errorf("provider = %s", res.Provider)
	}
}

func TestDetectExplicitOverride(t *testing.T) {
	a := &config.Account{
		Email:    "me@gmail.com",
		Provider: "imap",
		Host:     "custom.example.com",
		Port:     1993,
	}
	a.TLS = "none"
	res, err := Detect(context.Background(), a, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Provider != "imap" || res.Host != "custom.example.com" || res.Port != 1993 || res.TLS != "none" {
		t.Errorf("res = %+v", res)
	}
}

func TestDetectUnknownDomainFallback(t *testing.T) {
	a := &config.Account{Email: "user@nonexistent-domain-for-test.invalid"}
	a.TLS = "ssl"
	a.Provider = "auto"
	res, err := Detect(context.Background(), a, Options{Timeout: 200000000}) // 200ms，避免测试过慢
	if err != nil {
		t.Fatal(err)
	}
	if res.Provider != "imap" {
		t.Errorf("provider = %s", res.Provider)
	}
	if res.Host == "" || res.SMTPHost == "" {
		t.Errorf("fallback host missing: %+v", res)
	}
}
