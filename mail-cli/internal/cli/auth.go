package cli

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"mailcli/internal/oauth"
	"mailcli/internal/out"
	"mailcli/internal/store"
)

func (a *App) cmdAuth(args []string) (any, map[string]any, error) {
	if len(args) == 0 {
		return nil, nil, out.Usage("用法: mail auth <login|status|logout> [参数]")
	}
	switch args[0] {
	case "login":
		return a.authLogin(args[1:])
	case "status":
		return a.authStatus(args[1:])
	case "logout":
		return a.authLogout(args[1:])
	}
	return nil, nil, out.Usage("未知子命令: auth " + args[0])
}

func (a *App) authLogin(args []string) (any, map[string]any, error) {
	fs := newFlagSet("auth login")
	var manual, device bool
	fs.BoolVar(&manual, "manual", false, "无浏览器：手动粘贴回调 URL")
	fs.BoolVar(&device, "device", false, "设备码登录（Microsoft）")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	name, acct, err := a.account()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	provider := strings.ToLower(acct.Provider)
	if provider == "" || provider == "auto" {
		ctx, cancel := a.ctx()
		det, derr := a.detect(ctx, acct)
		cancel()
		if derr != nil {
			return nil, nil, mapErr(derr)
		}
		provider = det.Provider
	}
	if provider != "gmail" && provider != "graph" {
		e := out.Usage(fmt.Sprintf("账号 %s 判定为 IMAP 模式（%s），无需 OAuth 登录", name, provider))
		e.Hint = "如需使用 Gmail API / Microsoft Graph，请在配置中设置 provider = \"gmail\" 或 \"graph\" 并填写 client_id"
		return nil, nil, e
	}
	if acct.ClientID == "" {
		e := out.Usage("缺少 client_id")
		e.Hint = "在配置的该账号下填写 client_id（可同时填 client_secret），再执行本命令"
		return nil, nil, e
	}
	ep := oauth.EndpointsFor(provider, acct)
	st, err := a.dataStore()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	ctx := context.Background()
	timeout := 10 * time.Minute
	if a.g.Timeout > 60 && a.g.Timeout != 30 {
		timeout = time.Duration(a.g.Timeout) * time.Second
	}
	var tok *oauth.Token
	switch {
	case device:
		tok, err = oauth.DeviceCode(ctx, ep, acct.ClientID, acct.ClientSecret, os.Stdout, timeout)
	case manual:
		tok, err = oauth.Manual(ctx, ep, acct.ClientID, acct.ClientSecret, os.Stdout, bufio.NewReader(os.Stdin), timeout)
	default:
		tok, err = oauth.Loopback(ctx, ep, acct.ClientID, acct.ClientSecret, os.Stdout, timeout)
	}
	if err != nil {
		e := out.Auth(err.Error())
		e.Hint = "可改用 --manual（无浏览器）或 --device（Microsoft 设备码）"
		return nil, nil, e
	}
	if err := st.SaveToken(name, store.OAuthToken{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		TokenType:    tok.TokenType,
		Scope:        tok.Scope,
		Expiry:       tok.Expiry,
	}); err != nil {
		return nil, nil, mapErr(err)
	}
	if a.g.Human {
		fmt.Printf("授权成功，token 已保存到 %s\n", st.Dir())
	}
	return map[string]any{
		"account":     name,
		"provider":    provider,
		"expires_at":  tok.Expiry,
		"has_refresh": tok.RefreshToken != "",
		"saved_to":    st.Dir(),
	}, map[string]any{"account": name, "provider": provider}, nil
}

func (a *App) authStatus(args []string) (any, map[string]any, error) {
	fs := newFlagSet("auth status")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	st, err := a.dataStore()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	tokens, err := st.LoadTokens()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	type tokenInfo struct {
		Account    string    `json:"account"`
		HasAccess  bool      `json:"has_access"`
		HasRefresh bool      `json:"has_refresh"`
		Expiry     time.Time `json:"expiry"`
		Valid      bool      `json:"valid"`
		Scope      string    `json:"scope,omitempty"`
	}
	outList := make([]tokenInfo, 0, len(tokens))
	for name, t := range tokens {
		outList = append(outList, tokenInfo{
			Account:    name,
			HasAccess:  t.AccessToken != "",
			HasRefresh: t.RefreshToken != "",
			Expiry:     t.Expiry,
			Valid:      time.Now().Before(t.Expiry),
			Scope:      t.Scope,
		})
	}
	if a.g.Human {
		if len(outList) == 0 {
			fmt.Println("（暂无 OAuth token）")
		}
		for _, t := range outList {
			fmt.Printf("%-12s 有效期至 %s 刷新令牌:%v\n", t.Account, t.Expiry.Local().Format("2006-01-02 15:04"), t.HasRefresh)
		}
	}
	return outList, map[string]any{"data_dir": st.Dir()}, nil
}

func (a *App) authLogout(args []string) (any, map[string]any, error) {
	fs := newFlagSet("auth logout")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	name, _, err := a.account()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	st, err := a.dataStore()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	if err := st.DeleteToken(name); err != nil {
		return nil, nil, mapErr(err)
	}
	if a.g.Human {
		fmt.Printf("已清除账号 %s 的 OAuth token\n", name)
	}
	return map[string]any{"account": name, "cleared": true}, nil, nil
}
