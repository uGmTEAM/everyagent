package detect

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"mailcli/internal/config"
)

type Result struct {
	Provider string `json:"provider"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	TLS      string `json:"tls"`
	SMTPHost string `json:"smtp_host"`
	SMTPPort int    `json:"smtp_port"`
	SMTPTLS  string `json:"smtp_tls"`

	Reasons []string `json:"reasons"`
	Probes  []string `json:"probes,omitempty"`
}

type Options struct {
	Probe   bool
	Timeout time.Duration
	Log     func(format string, args ...any)
}

type preset struct {
	provider string
	host     string
	port     int
	tls      string
	smtpHost string
	smtpPort int
	smtpTLS  string
}

// 常见邮箱服务商预设，覆盖国内主流 + 国际常见
var presets = map[string]preset{
	"gmail.com":      {"imap", "imap.gmail.com", 993, "ssl", "smtp.gmail.com", 465, "ssl"},
	"googlemail.com": {"imap", "imap.gmail.com", 993, "ssl", "smtp.gmail.com", 465, "ssl"},

	"outlook.com": {"imap", "outlook.office365.com", 993, "ssl", "smtp.office365.com", 587, "starttls"},
	"hotmail.com": {"imap", "outlook.office365.com", 993, "ssl", "smtp.office365.com", 587, "starttls"},
	"live.com":    {"imap", "outlook.office365.com", 993, "ssl", "smtp.office365.com", 587, "starttls"},
	"msn.com":     {"imap", "outlook.office365.com", 993, "ssl", "smtp.office365.com", 587, "starttls"},
	"outlook.cn":  {"imap", "outlook.office365.com", 993, "ssl", "smtp.office365.com", 587, "starttls"},

	"qq.com":      {"imap", "imap.qq.com", 993, "ssl", "smtp.qq.com", 465, "ssl"},
	"foxmail.com": {"imap", "imap.qq.com", 993, "ssl", "smtp.qq.com", 465, "ssl"},
	"vip.qq.com":  {"imap", "imap.qq.com", 993, "ssl", "smtp.qq.com", 465, "ssl"},

	"163.com":  {"imap", "imap.163.com", 993, "ssl", "smtp.163.com", 465, "ssl"},
	"126.com":  {"imap", "imap.126.com", 993, "ssl", "smtp.126.com", 465, "ssl"},
	"yeah.net": {"imap", "imap.yeah.net", 993, "ssl", "smtp.yeah.net", 465, "ssl"},

	"sina.com": {"imap", "imap.sina.com", 993, "ssl", "smtp.sina.com", 465, "ssl"},
	"sina.cn":  {"imap", "imap.sina.cn", 993, "ssl", "smtp.sina.cn", 465, "ssl"},
	"sohu.com": {"imap", "imap.sohu.com", 993, "ssl", "smtp.sohu.com", 465, "ssl"},
	"139.com":  {"imap", "imap.139.com", 993, "ssl", "smtp.139.com", 465, "ssl"},
	"189.cn":   {"imap", "imap.189.cn", 993, "ssl", "smtp.189.cn", 465, "ssl"},
	"21cn.com": {"imap", "imap.21cn.com", 993, "ssl", "smtp.21cn.com", 465, "ssl"},

	"aliyun.com": {"imap", "imap.qiye.aliyun.com", 993, "ssl", "smtp.qiye.aliyun.com", 465, "ssl"},
	"aliyun.cn":  {"imap", "imap.qiye.aliyun.com", 993, "ssl", "smtp.qiye.aliyun.com", 465, "ssl"},

	"exmail.qq.com": {"imap", "imap.exmail.qq.com", 993, "ssl", "smtp.exmail.qq.com", 465, "ssl"},
	"feishu.cn":     {"imap", "imap.feishu.cn", 993, "ssl", "smtp.feishu.cn", 465, "ssl"},
	"larksuite.com": {"imap", "imap.feishu.cn", 993, "ssl", "smtp.feishu.cn", 465, "ssl"},

	"icloud.com":     {"imap", "imap.mail.me.com", 993, "ssl", "smtp.mail.me.com", 587, "starttls"},
	"me.com":         {"imap", "imap.mail.me.com", 993, "ssl", "smtp.mail.me.com", 587, "starttls"},
	"yahoo.com":      {"imap", "imap.mail.yahoo.com", 993, "ssl", "smtp.mail.yahoo.com", 465, "ssl"},
	"yandex.com":     {"imap", "imap.yandex.com", 993, "ssl", "smtp.yandex.com", 465, "ssl"},
	"gmx.com":        {"imap", "imap.gmx.com", 993, "ssl", "mail.gmx.com", 587, "starttls"},
	"protonmail.com": {"imap", "127.0.0.1", 1143, "starttls", "127.0.0.1", 1025, "starttls"},
}

func domainOf(email string) string {
	i := strings.LastIndex(email, "@")
	if i < 0 || i == len(email)-1 {
		return ""
	}
	return strings.ToLower(email[i+1:])
}

func hasOAuth(a *config.Account) bool {
	return a.ClientID != "" && (a.RefreshToken != "" || a.Password == "")
}

func isGoogle(id string) bool {
	return id == "gmail.com" || id == "googlemail.com"
}

func isMicrosoft(id string) bool {
	switch id {
	case "outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.cn":
		return true
	}
	return false
}

// Detect 按「显式配置 > OAuth 凭证嗅探 > 域名表 > MX 记录 > 常见主机探测」顺序识别
func Detect(ctx context.Context, a *config.Account, opt Options) (*Result, error) {
	if opt.Timeout <= 0 {
		opt.Timeout = 3 * time.Second
	}
	logf := opt.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	res := &Result{Provider: "imap"}
	dom := domainOf(a.Email)

	// 1) 显式指定 provider
	if a.Provider != "" && a.Provider != "auto" {
		res.Provider = strings.ToLower(a.Provider)
		res.Reasons = append(res.Reasons, "配置显式指定 provider="+a.Provider)
		res.Host, res.Port, res.TLS = a.Host, a.Port, a.TLS
		res.SMTPHost, res.SMTPPort, res.SMTPTLS = a.SMTPHost, a.SMTPPort, a.SMTPTLS
		if (res.Provider == "gmail" || res.Provider == "graph") && res.Host == "" {
			// API 模式不需要 IMAP 主机
			res.Port, res.TLS = 0, ""
		}
		fillFromPreset(res, dom)
		res.finish(a)
		return res, nil
	}

	// 2) 凭证嗅探：有 OAuth 三件套则走 API
	if hasOAuth(a) {
		if isGoogle(dom) || strings.Contains(a.TokenURL, "google") {
			res.Provider = "gmail"
			res.Reasons = append(res.Reasons, "检测到 client_id + refresh_token/无密码 → Gmail API")
			res.finish(a)
			return res, nil
		}
		if isMicrosoft(dom) || a.Tenant != "" || strings.Contains(a.TokenURL, "microsoft") {
			res.Provider = "graph"
			res.Reasons = append(res.Reasons, "检测到 client_id + refresh_token/无密码 → Microsoft Graph")
			res.finish(a)
			return res, nil
		}
		logf("检测到 OAuth 凭据但域名 %q 无法判定 API 类型，先按 IMAP 处理", dom)
	}

	// 3) 域名表
	if p, ok := presets[dom]; ok {
		res.Provider = p.provider
		res.Host, res.Port, res.TLS = p.host, p.port, p.tls
		res.SMTPHost, res.SMTPPort, res.SMTPTLS = p.smtpHost, p.smtpPort, p.smtpTLS
		res.Reasons = append(res.Reasons, fmt.Sprintf("域名 %s 命中预设（%s）", dom, p.host))
		res.finish(a)
		return res, nil
	}

	// 4) MX 记录推断
	if dom != "" {
		mxCtx, cancel := context.WithTimeout(ctx, opt.Timeout*2)
		mxs, err := net.DefaultResolver.LookupMX(mxCtx, dom)
		cancel()
		if err == nil && len(mxs) > 0 {
			hosts := make([]string, 0, len(mxs))
			for _, m := range mxs {
				hosts = append(hosts, strings.TrimSuffix(m.Host, "."))
			}
			res.Reasons = append(res.Reasons, "MX: "+strings.Join(hosts, ", "))
			if p, ok := presetFromMX(hosts); ok {
				res.Provider = p.provider
				res.Host, res.Port, res.TLS = p.host, p.port, p.tls
				res.SMTPHost, res.SMTPPort, res.SMTPTLS = p.smtpHost, p.smtpPort, p.smtpTLS
				res.Reasons = append(res.Reasons, "根据 MX 归入 "+p.host)
				res.finish(a)
				return res, nil
			}
		} else if err != nil {
			res.Reasons = append(res.Reasons, "MX 查询失败: "+err.Error())
		}
	}

	// 5) 常见主机名探测
	candidates := []struct {
		host string
		port int
		tls  string
	}{
		{"imap." + dom, 993, "ssl"},
		{"imap." + dom, 143, "starttls"},
		{"mail." + dom, 993, "ssl"},
		{"imap.mail." + dom, 993, "ssl"},
		{dom, 993, "ssl"},
		{dom, 143, "starttls"},
	}
	probeCtx, cancel := context.WithTimeout(ctx, opt.Timeout*time.Duration(len(candidates)+1))
	defer cancel()
	for _, c := range candidates {
		ok, info := probe(probeCtx, c.host, c.port, c.tls, opt.Timeout)
		res.Probes = append(res.Probes, info)
		if ok {
			res.Host, res.Port, res.TLS = c.host, c.port, c.tls
			res.Reasons = append(res.Reasons, fmt.Sprintf("探测到可用 IMAP: %s:%d (%s)", c.host, c.port, c.tls))
			break
		}
	}
	if res.Host == "" {
		res.Host, res.Port, res.TLS = "imap."+dom, 993, "ssl"
		res.Reasons = append(res.Reasons, "探测未命中，退回 imap."+dom+":993（如失败请在配置中显式指定 host）")
	}
	if res.SMTPHost == "" {
		res.SMTPHost, res.SMTPPort, res.SMTPTLS = "smtp."+dom, 465, "ssl"
	}
	res.finish(a)
	return res, nil
}

func (r *Result) finish(a *config.Account) {
	// 配置字段兜底覆盖
	if a.Host != "" {
		r.Host = a.Host
	}
	if a.Port > 0 {
		r.Port = a.Port
	}
	if a.TLS != "" {
		r.TLS = a.TLS
	}
	if a.SMTPHost != "" {
		r.SMTPHost = a.SMTPHost
	}
	if a.SMTPPort > 0 {
		r.SMTPPort = a.SMTPPort
	}
	if a.SMTPTLS != "" {
		r.SMTPTLS = a.SMTPTLS
	}
	if r.Provider == "" {
		r.Provider = "imap"
	}
}

func fillFromPreset(r *Result, dom string) {
	p, ok := presets[dom]
	if !ok {
		return
	}
	if r.Host == "" && r.Provider == "imap" {
		r.Host, r.Port, r.TLS = p.host, p.port, p.tls
	}
	if r.SMTPHost == "" {
		r.SMTPHost, r.SMTPPort, r.SMTPTLS = p.smtpHost, p.smtpPort, p.smtpTLS
	}
}

func presetFromMX(hosts []string) (preset, bool) {
	joined := strings.ToLower(strings.Join(hosts, " "))
	switch {
	case strings.Contains(joined, "google.com") || strings.Contains(joined, "googlemail.com"):
		return presets["gmail.com"], true
	case strings.Contains(joined, "outlook.com") || strings.Contains(joined, "office365"):
		return presets["outlook.com"], true
	case strings.Contains(joined, "qq.com"):
		return presets["exmail.qq.com"], true
	case strings.Contains(joined, "aliyun") || strings.Contains(joined, "mxhichina"):
		return presets["aliyun.com"], true
	case strings.Contains(joined, "163.com") || strings.Contains(joined, "netease"):
		return preset{"imap", "imap.qiye.163.com", 993, "ssl", "smtp.qiye.163.com", 465, "ssl"}, true
	case strings.Contains(joined, "feishu") || strings.Contains(joined, "larksuite"):
		return presets["feishu.cn"], true
	case strings.Contains(joined, "sina"):
		return presets["sina.com"], true
	}
	return preset{}, false
}

// probe 尝试建立连接（ssl 时完成 TLS 握手），返回可用于诊断的描述
func probe(ctx context.Context, host string, port int, mode string, timeout time.Duration) (bool, string) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	d := &net.Dialer{Timeout: timeout}
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return false, fmt.Sprintf("%s (%s) 连接失败: %v", addr, mode, err)
	}
	defer conn.Close()
	if mode == "ssl" {
		tc := tls.Client(conn, &tls.Config{ServerName: host})
		_ = tc.SetDeadline(time.Now().Add(timeout))
		if err := tc.Handshake(); err != nil {
			return false, fmt.Sprintf("%s (%s) TLS 握手失败: %v", addr, mode, err)
		}
		_ = tc.SetReadDeadline(time.Now().Add(timeout))
		br := bufio.NewReader(tc)
		line, _ := br.ReadString('\n')
		return strings.Contains(line, "* OK") || strings.Contains(line, "* PREAUTH"),
			fmt.Sprintf("%s (%s) 握手成功 %s，banner=%q", addr, mode, time.Since(start).Round(time.Millisecond), strings.TrimSpace(line))
	}
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	br := bufio.NewReader(conn)
	line, _ := br.ReadString('\n')
	return strings.Contains(line, "* OK") || strings.Contains(line, "* PREAUTH"),
		fmt.Sprintf("%s (%s) 连接成功 %s，banner=%q", addr, mode, time.Since(start).Round(time.Millisecond), strings.TrimSpace(line))
}
