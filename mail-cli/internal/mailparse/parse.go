package mailparse

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/encoding/htmlindex"
)

type Address struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email"`
}

type Attachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int    `json:"size"`
	Inline      bool   `json:"inline,omitempty"`
	SavedPath   string `json:"saved_path,omitempty"`
	Data        []byte `json:"-"`
}

type Parsed struct {
	Subject     string       `json:"subject"`
	From        []Address    `json:"from"`
	To          []Address    `json:"to"`
	Cc          []Address    `json:"cc"`
	ReplyTo     []Address    `json:"reply_to,omitempty"`
	Date        time.Time    `json:"date"`
	MessageID   string       `json:"message_id"`
	InReplyTo   string       `json:"in_reply_to,omitempty"`
	References  string       `json:"references,omitempty"`
	Text        string       `json:"text,omitempty"`
	HTML        string       `json:"html,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	RawSize     int          `json:"raw_size"`
}

// Parse 解析原始邮件。loadAttachments=false 时只保留附件元信息，避免大附件占内存。
func Parse(raw []byte, loadAttachments bool) (*Parsed, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("解析邮件失败: %w", err)
	}
	p := &Parsed{RawSize: len(raw)}
	dec := &mime.WordDecoder{CharsetReader: charsetReader}
	hv := func(k string) string {
		v := msg.Header.Get(k)
		if v == "" {
			return ""
		}
		if s, err := dec.DecodeHeader(v); err == nil {
			return s
		}
		return v
	}
	p.Subject = hv("Subject")
	p.MessageID = strings.TrimSpace(hv("Message-Id"))
	p.InReplyTo = strings.TrimSpace(hv("In-Reply-To"))
	p.References = strings.TrimSpace(hv("References"))
	if d, err := mail.ParseDate(msg.Header.Get("Date")); err == nil {
		p.Date = d
	}
	p.From = parseAddrs(hv("From"))
	p.To = parseAddrs(hv("To"))
	p.Cc = parseAddrs(hv("Cc"))
	p.ReplyTo = parseAddrs(hv("Reply-To"))

	walk(0, textproto.MIMEHeader(msg.Header), msg.Body, loadAttachments, p)

	if p.Text == "" && p.HTML != "" {
		p.Text = HTMLToText(p.HTML)
	}
	return p, nil
}

func parseAddrs(s string) []Address {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	list, err := mail.ParseAddressList(s)
	if err != nil || len(list) == 0 {
		// 退化处理：按逗号切分，保留原始地址
		var out []Address
		for _, part := range strings.Split(s, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			out = append(out, Address{Email: part})
		}
		return out
	}
	out := make([]Address, 0, len(list))
	for _, a := range list {
		out = append(out, Address{Name: a.Name, Email: a.Address})
	}
	return out
}

// walk 递归遍历 MIME 树，提取正文与附件
func walk(depth int, h textproto.MIMEHeader, r io.Reader, loadAttachments bool, p *Parsed) {
	if depth > 20 {
		return
	}
	ct := h.Get("Content-Type")
	if ct == "" {
		ct = "text/plain; charset=us-ascii"
	}
	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil {
		mediaType = "application/octet-stream"
	}
	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			return
		}
		mr := multipart.NewReader(r, boundary)
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				return
			}
			if err != nil {
				return
			}
			walk(depth+1, part.Header, part, loadAttachments, p)
		}
	}

	disp, dispParams, _ := mime.ParseMediaType(h.Get("Content-Disposition"))
	inline := disp == "inline"
	isText := strings.HasPrefix(mediaType, "text/")

	// 已经拿到正文的同类部件不再重复解析
	if isText && ((mediaType == "text/plain" && p.Text != "") || (mediaType == "text/html" && p.HTML != "")) {
		_, _ = io.Copy(io.Discard, r)
		return
	}

	limit := int64(8 << 20)
	if !isText || loadAttachments {
		limit = 64 << 20
	}
	body, err := io.ReadAll(io.LimitReader(decodeTransfer(h.Get("Content-Transfer-Encoding"), r), limit))
	if err != nil && len(body) == 0 {
		return
	}

	switch {
	case mediaType == "text/plain":
		p.Text = decodeCharset(body, params["charset"])
	case mediaType == "text/html":
		p.HTML = decodeCharset(body, params["charset"])
	case isText:
		if p.Text == "" {
			p.Text = decodeCharset(body, params["charset"])
		}
		if !loadAttachments && dispParams["filename"] != "" {
			p.Attachments = append(p.Attachments, Attachment{
				Filename:    decodeHeaderValue(dispParams["filename"]),
				ContentType: mediaType,
				Size:        len(body),
			})
		}
	default:
		fn := dispParams["filename"]
		if fn == "" {
			fn = params["name"]
		}
		if fn == "" {
			fn = "attachment"
		}
		att := Attachment{
			Filename:    decodeHeaderValue(fn),
			ContentType: mediaType,
			Size:        len(body),
			Inline:      inline,
		}
		if loadAttachments {
			att.Data = body
		}
		p.Attachments = append(p.Attachments, att)
	}
}

func decodeTransfer(enc string, r io.Reader) io.Reader {
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, newCRLFFilter(r))
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	default:
		return r
	}
}

// newCRLFFilter 容忍 base64 编码中的空白与折行
type crlfFilter struct {
	r   io.Reader
	rem []byte
}

func newCRLFFilter(r io.Reader) io.Reader { return &crlfFilter{r: r} }

func (f *crlfFilter) Read(p []byte) (int, error) {
	n := 0
	for n < len(p) {
		if len(f.rem) == 0 {
			tmp := make([]byte, 4096)
			m, err := f.r.Read(tmp)
			if m > 0 {
				f.rem = tmp[:m]
			}
			// 注意：Read 可能同时返回数据与 io.EOF，此时先消费数据
			if m == 0 && err != nil {
				if n > 0 {
					return n, nil
				}
				return 0, err
			}
		}
		if len(f.rem) == 0 {
			continue
		}
		i := 0
		for i < len(f.rem) && n < len(p) {
			c := f.rem[i]
			i++
			if c == '\r' || c == '\n' || c == ' ' || c == '\t' {
				continue
			}
			p[n] = c
			n++
		}
		f.rem = f.rem[i:]
		if n == len(p) {
			break
		}
	}
	return n, nil
}

func decodeHeaderValue(s string) string {
	dec := &mime.WordDecoder{CharsetReader: charsetReader}
	if out, err := dec.DecodeHeader(s); err == nil {
		return out
	}
	return s
}

// DecodeHeader 解码 RFC2047 编码的头部（如 =?UTF-8?B?...?=）
func DecodeHeader(s string) string { return decodeHeaderValue(s) }

// ParseAddressInput 将 "Name <mail>"、"mail" 字符串解析为地址结构
func ParseAddressInput(list []string) ([]Address, error) {
	out := make([]Address, 0, len(list))
	for _, item := range list {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		// 支持 "a@x.com, b@y.com" 写法
		if strings.Contains(item, ",") {
			sub, err := ParseAddressInput(strings.Split(item, ","))
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
			continue
		}
		a, err := mail.ParseAddress(item)
		if err != nil {
			if strings.Contains(item, "@") && !strings.ContainsAny(item, " <>,;") {
				out = append(out, Address{Email: item})
				continue
			}
			return nil, fmt.Errorf("无法解析地址 %q: %w", item, err)
		}
		out = append(out, Address{Name: a.Name, Email: a.Address})
	}
	return out, nil
}

func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	if isUTF8(charset) || strings.EqualFold(charset, "gb2312") || strings.EqualFold(charset, "gbk") ||
		strings.EqualFold(charset, "gb18030") || strings.EqualFold(charset, "big5") ||
		strings.EqualFold(charset, "iso-8859-1") || strings.EqualFold(charset, "windows-1252") {
		enc, err := htmlindex.Get(charset)
		if err != nil {
			// GBK 系统一按 GB18030 解码，覆盖面更广
			enc, err = htmlindex.Get("gb18030")
			if err != nil {
				return input, nil
			}
		}
		return enc.NewDecoder().Reader(input), nil
	}
	if enc, err := htmlindex.Get(charset); err == nil {
		return enc.NewDecoder().Reader(input), nil
	}
	return input, nil
}

func decodeCharset(b []byte, cs string) string {
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	if isUTF8(cs) {
		return string(b)
	}
	if enc, err := htmlindex.Get(cs); err == nil {
		if out, err := enc.NewDecoder().Bytes(b); err == nil {
			return string(out)
		}
	}
	if enc, err := htmlindex.Get("gb18030"); err == nil {
		if out, err := enc.NewDecoder().Bytes(b); err == nil && strings.Contains(string(out), "\uFFFD") == false {
			return string(out)
		}
	}
	return string(b)
}

func isUTF8(cs string) bool {
	switch strings.ToLower(strings.TrimSpace(cs)) {
	case "", "utf-8", "utf8", "us-ascii", "ascii":
		return true
	}
	return false
}

var (
	reScript = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)
	reBreak  = regexp.MustCompile(`(?i)<br\s*/?>`)
	reBlock  = regexp.MustCompile(`(?i)</(p|div|tr|li|h[1-6]|table)>`)
	reTag    = regexp.MustCompile(`(?s)<[^>]+>`)
	reBlank  = regexp.MustCompile(`[ \t\x{00a0}]+`)
	reNL     = regexp.MustCompile(`\n{3,}`)
)

// HTMLToText 轻量 HTML → 纯文本，供 AI 阅读正文
func HTMLToText(s string) string {
	s = reScript.ReplaceAllString(s, " ")
	s = reBreak.ReplaceAllString(s, "\n")
	s = reBlock.ReplaceAllString(s, "\n")
	s = reTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = reBlank.ReplaceAllString(s, " ")
	s = reNL.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

// FormatAddrs 地址列表转 "Name <mail>" 字符串
func FormatAddrs(list []Address) []string {
	out := make([]string, 0, len(list))
	for _, a := range list {
		if a.Name != "" {
			out = append(out, fmt.Sprintf("%s <%s>", a.Name, a.Email))
		} else {
			out = append(out, a.Email)
		}
	}
	return out
}
