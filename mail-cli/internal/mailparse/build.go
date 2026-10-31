package mailparse

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"mime"
	"sort"
	"strings"
	"time"
)

type OutgoingAttachment struct {
	Filename    string
	ContentType string
	Data        []byte
}

type BuildInput struct {
	From         Address
	To           []Address
	Cc           []Address
	Subject      string
	Text         string
	HTML         string
	Attachments  []OutgoingAttachment
	Date         time.Time
	MessageID    string
	InReplyTo    string
	References   string
	ExtraHeaders map[string]string
}

// Build 生成标准 MIME 邮件（UTF-8 + base64 正文，支持附件与中文文件名）
func Build(in BuildInput) ([]byte, error) {
	if in.Date.IsZero() {
		in.Date = time.Now()
	}
	if in.MessageID == "" {
		in.MessageID = newMessageID(in.From.Email)
	}
	var buf bytes.Buffer
	hdr := func(k, v string) {
		if v == "" {
			return
		}
		buf.WriteString(k)
		buf.WriteString(": ")
		buf.WriteString(v)
		buf.WriteString("\r\n")
	}
	hdr("From", formatAddr(in.From))
	hdr("To", joinAddrs(in.To))
	hdr("Cc", joinAddrs(in.Cc))
	hdr("Subject", mime.QEncoding.Encode("UTF-8", in.Subject))
	hdr("Date", in.Date.Format(time.RFC1123Z))
	hdr("Message-ID", in.MessageID)
	hdr("MIME-Version", "1.0")
	hdr("In-Reply-To", in.InReplyTo)
	hdr("References", in.References)
	hdr("User-Agent", "mail-cli/1.0")
	if len(in.ExtraHeaders) > 0 {
		keys := make([]string, 0, len(in.ExtraHeaders))
		for k := range in.ExtraHeaders {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			hdr(k, in.ExtraHeaders[k])
		}
	}

	// 正文：纯文本/HTML 双版本，缺失时自动补齐
	text := in.Text
	htmlBody := in.HTML
	if text == "" && htmlBody != "" {
		text = HTMLToText(htmlBody)
	}
	if htmlBody == "" && text != "" {
		htmlBody = "<pre>" + escapeHTML(text) + "</pre>"
	}

	hasAttach := len(in.Attachments) > 0
	if hasAttach {
		mixed := newBoundary()
		fmt.Fprintf(&buf, "Content-Type: multipart/mixed; boundary=%q\r\n\r\n", mixed)
		fmt.Fprintf(&buf, "--%s\r\n", mixed)
		writeAlternative(&buf, text, htmlBody)
		for _, a := range in.Attachments {
			fmt.Fprintf(&buf, "--%s\r\n", mixed)
			buf.WriteString("Content-Type: " + contentTypeOf(a) + "\r\n")
			buf.WriteString("Content-Transfer-Encoding: base64\r\n")
			buf.WriteString("Content-Disposition: " + contentDisposition(a.Filename) + "\r\n\r\n")
			writeBase64Lines(&buf, a.Data)
			buf.WriteString("\r\n")
		}
		fmt.Fprintf(&buf, "--%s--\r\n", mixed)
	} else {
		writeAlternative(&buf, text, htmlBody)
	}
	return buf.Bytes(), nil
}

func writeAlternative(w *bytes.Buffer, text, htmlBody string) {
	if text == "" && htmlBody == "" {
		w.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		w.WriteString("Content-Transfer-Encoding: base64\r\n\r\n\r\n")
		return
	}
	if text == "" || htmlBody == "" {
		ct := "text/plain"
		body := text
		if htmlBody != "" {
			ct, body = "text/html", htmlBody
		}
		fmt.Fprintf(w, "Content-Type: %s; charset=utf-8\r\n", ct)
		w.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		writeBase64Lines(w, []byte(body))
		w.WriteString("\r\n")
		return
	}
	alt := newBoundary()
	fmt.Fprintf(w, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", alt)
	fmt.Fprintf(w, "--%s\r\n", alt)
	w.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	w.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	writeBase64Lines(w, []byte(text))
	w.WriteString("\r\n")
	fmt.Fprintf(w, "--%s\r\n", alt)
	w.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	w.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	writeBase64Lines(w, []byte(htmlBody))
	w.WriteString("\r\n")
	fmt.Fprintf(w, "--%s--\r\n", alt)
}

func writeBase64Lines(w *bytes.Buffer, data []byte) {
	enc := base64.StdEncoding.EncodeToString(data)
	for len(enc) > 76 {
		w.WriteString(enc[:76])
		w.WriteString("\r\n")
		enc = enc[76:]
	}
	if enc != "" {
		w.WriteString(enc)
		w.WriteString("\r\n")
	}
}

func formatAddr(a Address) string {
	if a.Name == "" {
		return a.Email
	}
	return fmt.Sprintf("%s <%s>", mime.QEncoding.Encode("UTF-8", a.Name), a.Email)
}

func joinAddrs(list []Address) string {
	parts := make([]string, 0, len(list))
	for _, a := range list {
		parts = append(parts, formatAddr(a))
	}
	return strings.Join(parts, ", ")
}

func contentTypeOf(a OutgoingAttachment) string {
	ct := a.ContentType
	if ct == "" {
		ct = mime.TypeByExtension(extOf(a.Filename))
		if ct == "" {
			ct = "application/octet-stream"
		}
	}
	if !strings.Contains(ct, "charset") && strings.HasPrefix(ct, "text/") {
		ct += "; charset=utf-8"
	}
	return ct
}

func extOf(name string) string {
	i := strings.LastIndex(name, ".")
	if i < 0 {
		return ""
	}
	return name[i:]
}

// contentDisposition 中文文件名使用 RFC2231 编码
func contentDisposition(filename string) string {
	if isASCII(filename) {
		return fmt.Sprintf("attachment; filename=%q", filename)
	}
	var b strings.Builder
	for _, c := range []byte(filename) {
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '.' || c == '-' || c == '_' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return fmt.Sprintf("attachment; filename*=UTF-8''%s", b.String())
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func escapeHTML(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

func newBoundary() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "==mailcli_" + hex.EncodeToString(b) + "_=="
}

func newMessageID(from string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	dom := "mail-cli.local"
	if i := strings.LastIndex(from, "@"); i > 0 {
		dom = from[i+1:]
	}
	return fmt.Sprintf("<%d.%s@%s>", time.Now().UnixNano(), hex.EncodeToString(b), dom)
}

// NewMessageID 供上层在发送前生成并复用 Message-ID
func NewMessageID(from string) string { return newMessageID(from) }

// QuoteText 回复时引用原文（> 前缀）
func QuoteText(header string, body string) string {
	var b strings.Builder
	b.WriteString(header)
	b.WriteString("\n")
	for _, line := range strings.Split(strings.TrimRight(body, "\n"), "\n") {
		b.WriteString("> ")
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}
