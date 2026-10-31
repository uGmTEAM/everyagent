package mailparse

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestBuildAndParseRoundTrip(t *testing.T) {
	raw, err := Build(BuildInput{
		From:    Address{Name: "张三", Email: "zhangsan@example.com"},
		To:      []Address{{Name: "李四", Email: "lisi@example.com"}},
		Cc:      []Address{{Email: "cc@example.com"}},
		Subject: "测试主题：中文与 emoji 🚀",
		Text:    "这是一封测试邮件。",
		HTML:    "<p>这是 <b>HTML</b> 正文</p>",
		Attachments: []OutgoingAttachment{
			{Filename: "报告 2026.pdf", Data: []byte("PDFDATA")},
		},
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	p, err := Parse(raw, true)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p.Subject != "测试主题：中文与 emoji 🚀" {
		t.Errorf("subject = %q", p.Subject)
	}
	if len(p.From) != 1 || p.From[0].Email != "zhangsan@example.com" || p.From[0].Name != "张三" {
		t.Errorf("from = %+v", p.From)
	}
	if len(p.To) != 1 || p.To[0].Email != "lisi@example.com" {
		t.Errorf("to = %+v", p.To)
	}
	if !strings.Contains(p.Text, "测试邮件") {
		t.Errorf("text = %q", p.Text)
	}
	if !strings.Contains(p.HTML, "<b>HTML</b>") {
		t.Errorf("html = %q", p.HTML)
	}
	if len(p.Attachments) != 1 {
		t.Fatalf("attachments = %+v", p.Attachments)
	}
	if p.Attachments[0].Filename != "报告 2026.pdf" {
		t.Errorf("attachment name = %q", p.Attachments[0].Filename)
	}
	if string(p.Attachments[0].Data) != "PDFDATA" {
		t.Errorf("attachment data = %q", p.Attachments[0].Data)
	}
	if p.MessageID == "" {
		t.Error("message id empty")
	}
}

func TestParseGBKBody(t *testing.T) {
	gbk, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("中文编码测试"))
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.StdEncoding.EncodeToString(gbk)
	raw := "From: a@b.com\r\n" +
		"To: c@d.com\r\n" +
		"Subject: =?GBK?B?" + base64.StdEncoding.EncodeToString(mustGBK("主题测试")) + "?=\r\n" +
		"Content-Type: text/plain; charset=gbk\r\n" +
		"Content-Transfer-Encoding: base64\r\n" +
		"\r\n" + enc + "\r\n"
	p, err := Parse([]byte(raw), false)
	if err != nil {
		t.Fatal(err)
	}
	if p.Text != "中文编码测试" {
		t.Errorf("text = %q", p.Text)
	}
	if p.Subject != "主题测试" {
		t.Errorf("subject = %q", p.Subject)
	}
}

func mustGBK(s string) []byte {
	b, _ := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(s))
	return b
}

func TestParseMultipartNoAttachmentLoad(t *testing.T) {
	raw, err := Build(BuildInput{
		From:    Address{Email: "a@b.com"},
		To:      []Address{{Email: "c@d.com"}},
		Subject: "附件元信息",
		Text:    "body",
		Attachments: []OutgoingAttachment{
			{Filename: "a.bin", Data: bytes.Repeat([]byte("x"), 1024)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	p, err := Parse(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Attachments) != 1 {
		t.Fatalf("attachments = %+v", p.Attachments)
	}
	if p.Attachments[0].Filename != "a.bin" {
		t.Errorf("filename = %q", p.Attachments[0].Filename)
	}
	if len(p.Attachments[0].Data) != 0 {
		t.Errorf("attachment data should be skipped, got %d bytes", len(p.Attachments[0].Data))
	}
}

func TestHTMLToText(t *testing.T) {
	in := `<html><head><style>p{color:red}</style></head><body><p>你好&nbsp;世界</p><br><div>第二段</div><script>alert(1)</script></body></html>`
	got := HTMLToText(in)
	if !strings.Contains(got, "你好 世界") || !strings.Contains(got, "第二段") {
		t.Errorf("html2text = %q", got)
	}
	if strings.Contains(got, "alert") || strings.Contains(got, "color:red") {
		t.Errorf("script/style not stripped: %q", got)
	}
}

func TestParseAddressInput(t *testing.T) {
	list, err := ParseAddressInput([]string{"张三 <a@b.com>, c@d.com", "e@f.com"})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("len = %d: %+v", len(list), list)
	}
	if list[0].Name != "张三" || list[0].Email != "a@b.com" {
		t.Errorf("first = %+v", list[0])
	}
}

func TestQuoteText(t *testing.T) {
	got := QuoteText("On date, x wrote:", "第一行\n第二行")
	if !strings.Contains(got, "> 第一行") || !strings.Contains(got, "> 第二行") {
		t.Errorf("quote = %q", got)
	}
}
