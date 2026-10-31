package engine

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"mailcli/internal/config"
	"mailcli/internal/detect"
)

// sendSMTP 按 ssl / starttls / none 三种模式投递
func sendSMTP(acct *config.Account, det *detect.Result, raw []byte, from string, rcpts []string, timeout time.Duration) error {
	host := det.SMTPHost
	port := det.SMTPPort
	if host == "" {
		return ewrap(KindConfig, fmt.Errorf("缺少 SMTP 服务器地址"))
	}
	if port == 0 {
		port = 465
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	tlsCfg := &tls.Config{ServerName: host, InsecureSkipVerify: acct.InsecureSkipVerify}

	var c *smtp.Client
	var err error
	switch strings.ToLower(det.SMTPTLS) {
	case "ssl", "tls", "":
		conn, derr := tls.DialWithDialer(&net.Dialer{Timeout: timeout}, "tcp", addr, tlsCfg)
		if derr != nil {
			return ewrap(KindNetwork, fmt.Errorf("SMTP 连接失败: %w", derr))
		}
		c, err = smtp.NewClient(conn, host)
	case "starttls":
		c, err = smtp.Dial(addr)
		if err == nil {
			if ok, _ := c.Extension("STARTTLS"); ok {
				err = c.StartTLS(tlsCfg)
			}
		}
	case "none":
		c, err = smtp.Dial(addr)
	default:
		return ewrap(KindConfig, fmt.Errorf("未知 SMTP TLS 模式: %s", det.SMTPTLS))
	}
	if err != nil {
		return ewrap(KindNetwork, fmt.Errorf("SMTP 建立会话失败: %w", err))
	}
	defer c.Close()

	if ok, _ := c.Extension("AUTH"); ok {
		auth := smtp.PlainAuth("", acct.Username, acct.ResolvePassword(), host)
		if err := c.Auth(auth); err != nil {
			return ewrap(KindAuth, fmt.Errorf("SMTP 认证失败: %w", err))
		}
	}
	if err := c.Mail(from); err != nil {
		return ewrap(KindGeneral, fmt.Errorf("SMTP MAIL FROM 失败: %w", err))
	}
	for _, r := range rcpts {
		if err := c.Rcpt(r); err != nil {
			return ewrap(KindGeneral, fmt.Errorf("收件人被拒绝 %s: %w", r, err))
		}
	}
	w, err := c.Data()
	if err != nil {
		return ewrap(KindGeneral, fmt.Errorf("SMTP DATA 失败: %w", err))
	}
	if _, err := w.Write(raw); err != nil {
		return ewrap(KindNetwork, fmt.Errorf("SMTP 发送正文失败: %w", err))
	}
	if err := w.Close(); err != nil {
		return ewrap(KindGeneral, fmt.Errorf("SMTP 完成投递失败: %w", err))
	}
	_ = c.Quit()
	return nil
}
