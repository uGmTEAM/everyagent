package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"mailcli/internal/config"
	"mailcli/internal/oauth"
	"mailcli/internal/store"
)

// apiClient 封装 Gmail / Graph 共用的 OAuth + JSON 请求逻辑
type apiClient struct {
	provider string
	acct     *config.Account
	name     string
	st       *store.Store
	ep       oauth.Endpoints
	base     string
	timeout  time.Duration
}

func (c *apiClient) token(ctx context.Context) (string, error) {
	tok, err := oauth.Ensure(ctx, c.name, c.acct, c.st, c.ep)
	if err != nil {
		return "", ewrap(KindAuth, err)
	}
	return tok, nil
}

func (c *apiClient) do(ctx context.Context, method, path string, body any, out any) error {
	tok, err := c.token(ctx)
	if err != nil {
		return err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return ewrap(KindGeneral, err)
		}
		rd = bytes.NewReader(b)
	}
	url := c.base + path
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return ewrap(KindGeneral, err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: c.timeout}
	resp, err := client.Do(req)
	if err != nil {
		return ewrap(KindNetwork, fmt.Errorf("%s 请求失败: %w", c.provider, err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode/100 != 2 {
		return apiError(c.provider, resp.StatusCode, raw)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return ewrap(KindGeneral, fmt.Errorf("%s 响应解析失败: %w", c.provider, err))
		}
	}
	return nil
}

func (c *apiClient) getRaw(ctx context.Context, path string) ([]byte, error) {
	tok, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, ewrap(KindGeneral, err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	hc := &http.Client{Timeout: c.timeout}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, ewrap(KindNetwork, fmt.Errorf("%s 下载失败: %w", c.provider, err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode/100 != 2 {
		return nil, apiError(c.provider, resp.StatusCode, raw)
	}
	return raw, nil
}

func apiError(provider string, status int, body []byte) error {
	msg := strings.TrimSpace(string(body))
	var ge struct {
		Error struct {
			Message string `json:"message"`
			Code    any    `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &ge) == nil && ge.Error.Message != "" {
		msg = ge.Error.Message
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ewrap(KindAuth, fmt.Errorf("%s 认证失败(HTTP %d): %s", provider, status, truncateStr(msg, 300)))
	case http.StatusNotFound:
		return ewrap(KindNotFound, fmt.Errorf("%s 资源不存在(HTTP %d): %s", provider, status, truncateStr(msg, 300)))
	}
	return ewrap(KindNetwork, fmt.Errorf("%s 返回 HTTP %d: %s", provider, status, truncateStr(msg, 300)))
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
