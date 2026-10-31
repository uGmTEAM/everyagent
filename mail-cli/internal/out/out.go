package out

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// 统一输出信封，AI 侧只需判断 ok 字段。
type Envelope struct {
	OK    bool           `json:"ok"`
	Data  any            `json:"data,omitempty"`
	Error *Error         `json:"error,omitempty"`
	Meta  map[string]any `json:"meta,omitempty"`
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
	Exit    int    `json:"-"`
}

func (e *Error) Error() string { return e.Message }

// 退出码约定：0 成功 / 1 通用 / 2 用法或配置 / 3 认证 / 4 网络或服务端 / 5 未找到
func New(exit int, msg string) *Error {
	return &Error{Code: errCodeName(exit), Message: msg, Exit: exit}
}

func errCodeName(exit int) string {
	switch exit {
	case 2:
		return "usage"
	case 3:
		return "auth"
	case 4:
		return "network"
	case 5:
		return "not_found"
	default:
		return "error"
	}
}

func Usage(msg string) *Error   { return &Error{Code: "usage", Message: msg, Exit: 2} }
func Auth(msg string) *Error    { return &Error{Code: "auth", Message: msg, Exit: 3} }
func Network(msg string) *Error { return &Error{Code: "network", Message: msg, Exit: 4} }
func NotFound(msg string) *Error {
	return &Error{Code: "not_found", Message: msg, Exit: 5}
}
func General(msg string) *Error { return &Error{Code: "error", Message: msg, Exit: 1} }

// 带提示的错误，便于 AI 自行纠正
func Wrap(err error, exit int, hint string) *Error {
	if err == nil {
		return nil
	}
	if e, ok := err.(*Error); ok {
		if e.Hint == "" {
			e.Hint = hint
		}
		return e
	}
	e := &Error{Code: errCodeName(exit), Message: err.Error(), Exit: exit}
	e.Hint = hint
	return e
}

func WriteJSON(w io.Writer, env Envelope) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(env)
}

// Fail 输出错误信封并返回退出码
func Fail(err *Error) int {
	if err == nil {
		return 0
	}
	WriteJSON(os.Stdout, Envelope{OK: false, Error: err})
	if err.Hint != "" {
		fmt.Fprintf(os.Stderr, "提示: %s\n", err.Hint)
	}
	if err.Exit == 0 {
		return 1
	}
	return err.Exit
}

func OK(data any, meta map[string]any) int {
	WriteJSON(os.Stdout, Envelope{OK: true, Data: data, Meta: meta})
	return 0
}

// OKLine 流式命令（watch）使用单行 JSON，避免破坏 NDJSON 解析
func OKLine(data any, meta map[string]any) int {
	b, err := json.Marshal(Envelope{OK: true, Data: data, Meta: meta})
	if err != nil {
		return Fail(General(err.Error()))
	}
	fmt.Fprintln(os.Stdout, string(b))
	return 0
}
