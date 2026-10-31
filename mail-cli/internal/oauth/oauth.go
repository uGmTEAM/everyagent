package oauth

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"mailcli/internal/config"
	"mailcli/internal/store"
)

type Endpoints struct {
	AuthURL   string
	TokenURL  string
	DeviceURL string
	Scopes    []string
}

type Token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type"`
	Scope        string    `json:"scope"`
	Expiry       time.Time `json:"expiry"`
}

func (t Token) Valid() bool {
	return t.AccessToken != "" && (t.Expiry.IsZero() || time.Now().Before(t.Expiry.Add(-30*time.Second)))
}

func EndpointsFor(provider string, a *config.Account) Endpoints {
	tenant := a.Tenant
	if tenant == "" {
		tenant = "common"
	}
	var ep Endpoints
	switch provider {
	case "gmail":
		ep = Endpoints{
			AuthURL:   "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL:  "https://oauth2.googleapis.com/token",
			DeviceURL: "https://oauth2.googleapis.com/device/code",
			Scopes: []string{
				"https://www.googleapis.com/auth/gmail.modify",
				"https://www.googleapis.com/auth/gmail.send",
			},
		}
	case "graph":
		base := "https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0"
		ep = Endpoints{
			AuthURL:   base + "/authorize",
			TokenURL:  base + "/token",
			DeviceURL: base + "/devicecode",
			Scopes: []string{
				"offline_access",
				"https://graph.microsoft.com/Mail.ReadWrite",
				"https://graph.microsoft.com/Mail.Send",
				"https://graph.microsoft.com/User.Read",
			},
		}
	default:
		ep = Endpoints{}
	}
	if a.AuthURL != "" {
		ep.AuthURL = a.AuthURL
	}
	if a.TokenURL != "" {
		ep.TokenURL = a.TokenURL
	}
	if a.DeviceURL != "" {
		ep.DeviceURL = a.DeviceURL
	}
	if len(a.Scopes) > 0 {
		ep.Scopes = a.Scopes
	}
	return ep
}

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresIn        int    `json:"expires_in"`
	Scope            string `json:"scope"`
	TokenType        string `json:"token_type"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func (tr *tokenResponse) toToken() *Token {
	if tr.AccessToken == "" {
		return nil
	}
	t := &Token{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		Scope:        tr.Scope,
		TokenType:    tr.TokenType,
	}
	if tr.ExpiresIn > 0 {
		t.Expiry = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	}
	return t
}

func postForm(ctx context.Context, endpoint string, form url.Values) (*tokenResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var tr tokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("token 响应无法解析(HTTP %d): %s", resp.StatusCode, truncate(string(body), 300))
	}
	if tr.Error != "" {
		return &tr, fmt.Errorf("%s: %s", tr.Error, tr.ErrorDescription)
	}
	if resp.StatusCode/100 != 2 {
		return &tr, fmt.Errorf("token 请求失败 HTTP %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return &tr, nil
}

func Exchange(ctx context.Context, ep Endpoints, clientID, clientSecret, code, redirectURI string) (*Token, error) {
	form := url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {code},
		"client_id":    {clientID},
		"redirect_uri": {redirectURI},
	}
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	tr, err := postForm(ctx, ep.TokenURL, form)
	if err != nil {
		return nil, err
	}
	t := tr.toToken()
	if t == nil {
		return nil, fmt.Errorf("token 响应缺少 access_token")
	}
	return t, nil
}

func Refresh(ctx context.Context, ep Endpoints, clientID, clientSecret, refreshToken string) (*Token, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {clientID},
	}
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	tr, err := postForm(ctx, ep.TokenURL, form)
	if err != nil {
		return nil, err
	}
	t := tr.toToken()
	if t == nil {
		return nil, fmt.Errorf("刷新响应缺少 access_token")
	}
	if t.RefreshToken == "" {
		t.RefreshToken = refreshToken
	}
	return t, nil
}

// Ensure 返回可用 access_token，必要时用 refresh_token 自动续期并落盘
func Ensure(ctx context.Context, accountName string, a *config.Account, st *store.Store, ep Endpoints) (string, error) {
	cached, _, err := st.GetToken(accountName)
	if err != nil {
		return "", err
	}
	tok := Token{AccessToken: cached.AccessToken, RefreshToken: cached.RefreshToken, Expiry: cached.Expiry}
	if tok.Valid() {
		return tok.AccessToken, nil
	}
	refresh := tok.RefreshToken
	if refresh == "" {
		refresh = a.RefreshToken
	}
	if refresh == "" {
		return "", fmt.Errorf("账号 %s 缺少 OAuth refresh_token，请先执行: mail auth login --account %s", accountName, accountName)
	}
	if a.ClientID == "" {
		return "", fmt.Errorf("账号 %s 缺少 client_id，无法完成 OAuth 刷新", accountName)
	}
	nt, err := Refresh(ctx, ep, a.ClientID, a.ClientSecret, refresh)
	if err != nil {
		return "", fmt.Errorf("刷新 OAuth token 失败: %w", err)
	}
	_ = st.SaveToken(accountName, store.OAuthToken{
		AccessToken:  nt.AccessToken,
		RefreshToken: nt.RefreshToken,
		TokenType:    nt.TokenType,
		Scope:        nt.Scope,
		Expiry:       nt.Expiry,
	})
	return nt.AccessToken, nil
}

func randomState() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Loopback 本机回调登录（桌面/服务器带浏览器转发均可）
func Loopback(ctx context.Context, ep Endpoints, clientID, clientSecret string, w io.Writer, timeout time.Duration) (*Token, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer ln.Close()
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)
	state := randomState()

	type result struct {
		tok *Token
		err error
	}
	ch := make(chan result, 1)
	srv := &http.Server{}
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(rw http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("error") != "" {
			fmt.Fprintf(rw, "授权失败: %s", q.Get("error"))
			ch <- result{err: fmt.Errorf("授权失败: %s", q.Get("error_description"))}
			return
		}
		if q.Get("state") != state {
			fmt.Fprintf(rw, "state 校验失败")
			ch <- result{err: fmt.Errorf("state 校验失败，请重试")}
			return
		}
		tok, err := Exchange(context.Background(), ep, clientID, clientSecret, q.Get("code"), redirect)
		if err != nil {
			fmt.Fprintf(rw, "换取 token 失败: %v", err)
			ch <- result{err: err}
			return
		}
		fmt.Fprint(rw, "授权完成，可以关闭此页面返回终端。")
		ch <- result{tok: tok}
	})
	srv.Handler = mux
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	authURL := buildAuthURL(ep, clientID, redirect, state)
	fmt.Fprintf(w, "请在浏览器打开以下地址完成授权（%s 内有效）：\n%s\n", timeout, authURL)

	select {
	case r := <-ch:
		return r.tok, r.err
	case <-time.After(timeout):
		return nil, fmt.Errorf("等待授权超时")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Manual 无浏览器环境：手动粘贴回调 URL 或 code
func Manual(ctx context.Context, ep Endpoints, clientID, clientSecret string, w io.Writer, in *bufio.Reader, timeout time.Duration) (*Token, error) {
	redirect := "http://127.0.0.1:1/callback"
	state := randomState()
	authURL := buildAuthURL(ep, clientID, redirect, state)
	fmt.Fprintf(w, "1) 在任意有浏览器的设备打开：\n%s\n", authURL)
	fmt.Fprintf(w, "2) 授权后浏览器会跳转到 127.0.0.1 并显示无法连接，复制地址栏完整 URL（或其中的 code 参数）粘贴到这里：\n> ")
	line, err := readLine(in, timeout)
	if err != nil {
		return nil, err
	}
	code := extractCode(line, state)
	if code == "" {
		return nil, fmt.Errorf("未能从输入中解析出授权码")
	}
	return Exchange(ctx, ep, clientID, clientSecret, code, redirect)
}

func extractCode(input, state string) string {
	input = strings.TrimSpace(input)
	if input == "" {
		return ""
	}
	if strings.Contains(input, "code=") {
		if u, err := url.Parse(input); err == nil {
			q := u.Query()
			if st := q.Get("state"); st != "" && state != "" && st != state {
				return ""
			}
			return q.Get("code")
		}
	}
	return input
}

// DeviceCode 设备码登录（Microsoft 支持；Google 仅限特定客户端类型）
func DeviceCode(ctx context.Context, ep Endpoints, clientID, clientSecret string, w io.Writer, timeout time.Duration) (*Token, error) {
	if ep.DeviceURL == "" {
		return nil, fmt.Errorf("当前服务商未配置设备码端点")
	}
	form := url.Values{
		"client_id": {clientID},
		"scope":     {strings.Join(ep.Scopes, " ")},
	}
	body, status, err := postRaw(ctx, ep.DeviceURL, form)
	if err != nil {
		return nil, err
	}
	var dc struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
		Error           string `json:"error"`
		ErrorDesc       string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &dc); err != nil {
		return nil, fmt.Errorf("设备码响应无法解析(HTTP %d): %s", status, truncate(string(body), 300))
	}
	if dc.DeviceCode == "" {
		return nil, fmt.Errorf("设备码申请失败: %s %s", dc.Error, dc.ErrorDesc)
	}
	if dc.Interval <= 0 {
		dc.Interval = 5
	}
	fmt.Fprintf(w, "请访问 %s 并输入代码 %s（%d 秒内有效）\n", dc.VerificationURI, dc.UserCode, dc.ExpiresIn)

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(dc.Interval) * time.Second):
		}
		tf := url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"device_code": {dc.DeviceCode},
			"client_id":   {clientID},
		}
		if clientSecret != "" {
			tf.Set("client_secret", clientSecret)
		}
		tr, err := postForm(ctx, ep.TokenURL, tf)
		if err != nil {
			msg := err.Error()
			switch {
			case strings.Contains(msg, "authorization_pending"):
				continue
			case strings.Contains(msg, "slow_down"):
				dc.Interval += 5
				continue
			case strings.Contains(msg, "expired_token"):
				return nil, fmt.Errorf("设备码已过期，请重试")
			default:
				return nil, err
			}
		}
		if t := tr.toToken(); t != nil {
			return t, nil
		}
	}
	return nil, fmt.Errorf("等待设备码授权超时")
}

func postRaw(ctx context.Context, endpoint string, form url.Values) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return b, resp.StatusCode, nil
}

func buildAuthURL(ep Endpoints, clientID, redirect, state string) string {
	q := url.Values{
		"client_id":     {clientID},
		"response_type": {"code"},
		"redirect_uri":  {redirect},
		"scope":         {strings.Join(ep.Scopes, " ")},
		"state":         {state},
		"access_type":   {"offline"},
		"prompt":        {"consent"},
	}
	sep := "?"
	if strings.Contains(ep.AuthURL, "?") {
		sep = "&"
	}
	return ep.AuthURL + sep + q.Encode()
}

func readLine(in *bufio.Reader, timeout time.Duration) (string, error) {
	type res struct {
		s   string
		err error
	}
	ch := make(chan res, 1)
	go func() {
		s, err := in.ReadString('\n')
		ch <- res{s, err}
	}()
	select {
	case r := <-ch:
		return strings.TrimSpace(r.s), r.err
	case <-time.After(timeout):
		return "", fmt.Errorf("输入超时")
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
