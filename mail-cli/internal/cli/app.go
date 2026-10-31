package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"mailcli/internal/config"
	"mailcli/internal/detect"
	"mailcli/internal/engine"
	"mailcli/internal/out"
	"mailcli/internal/store"
)

const Version = "1.0.0"

type globalOpts struct {
	ConfigPath string
	Account    string
	DataDir    string
	Timeout    int
	Human      bool
	Verbose    bool
}

type App struct {
	g     globalOpts
	cfg   *config.Config
	store *store.Store
}

// extractGlobals 允许全局参数出现在命令前后任意位置
func extractGlobals(args []string) (globalOpts, []string) {
	g := globalOpts{Timeout: 30}
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		next := func() string {
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch {
		case a == "--config" || a == "-config":
			g.ConfigPath = next()
		case strings.HasPrefix(a, "--config="):
			g.ConfigPath = strings.TrimPrefix(a, "--config=")
		case a == "--account" || a == "-account":
			g.Account = next()
		case strings.HasPrefix(a, "--account="):
			g.Account = strings.TrimPrefix(a, "--account=")
		case a == "--data-dir":
			g.DataDir = next()
		case strings.HasPrefix(a, "--data-dir="):
			g.DataDir = strings.TrimPrefix(a, "--data-dir=")
		case a == "--timeout":
			fmt.Sscanf(next(), "%d", &g.Timeout)
		case strings.HasPrefix(a, "--timeout="):
			fmt.Sscanf(strings.TrimPrefix(a, "--timeout="), "%d", &g.Timeout)
		case a == "--human" || a == "-human":
			g.Human = true
		case a == "--verbose" || a == "-v":
			g.Verbose = true
		case a == "--json":
			g.Human = false
		default:
			rest = append(rest, a)
		}
	}
	return g, rest
}

// addCommon 把全局参数注册进子命令 FlagSet
func (a *App) addCommon(fs *flag.FlagSet) {
	fs.StringVar(&a.g.ConfigPath, "config", a.g.ConfigPath, "配置文件路径")
	fs.StringVar(&a.g.Account, "account", a.g.Account, "账号名")
	fs.StringVar(&a.g.DataDir, "data-dir", a.g.DataDir, "数据目录")
	fs.IntVar(&a.g.Timeout, "timeout", a.g.Timeout, "超时秒数")
	fs.BoolVar(&a.g.Human, "human", a.g.Human, "人类可读输出")
	fs.BoolVar(&a.g.Verbose, "verbose", a.g.Verbose, "输出调试信息到 stderr")
}

func (a *App) loadConfig() error {
	path, err := config.FindConfig(a.g.ConfigPath)
	if err != nil {
		return err
	}
	cfg, err := config.Load(path)
	if err != nil {
		return fmt.Errorf("读取配置 %s 失败: %w", path, err)
	}
	if a.g.DataDir != "" {
		cfg.DataDir = a.g.DataDir
	}
	a.cfg = cfg
	return nil
}

func (a *App) initStore() error {
	st, err := store.Open(a.cfg.DataDir)
	if err != nil {
		return fmt.Errorf("初始化数据目录失败: %w", err)
	}
	a.store = st
	return nil
}

func (a *App) account() (string, *config.Account, error) {
	if a.cfg == nil {
		if err := a.loadConfig(); err != nil {
			return "", nil, err
		}
	}
	return a.cfg.Account(a.g.Account)
}

func (a *App) dataStore() (*store.Store, error) {
	if a.store != nil {
		return a.store, nil
	}
	if a.cfg == nil {
		if err := a.loadConfig(); err != nil {
			return nil, err
		}
	}
	if err := a.initStore(); err != nil {
		return nil, err
	}
	return a.store, nil
}

func (a *App) logf(format string, args ...any) {
	if a.g.Verbose {
		fmt.Fprintf(os.Stderr, format+"\n", args...)
	}
}

func (a *App) detect(ctx context.Context, acct *config.Account) (*detect.Result, error) {
	return detect.Detect(ctx, acct, detect.Options{
		Probe:   true,
		Timeout: 3 * time.Second,
		Log:     a.logf,
	})
}

func (a *App) openClient(ctx context.Context) (engine.Client, string, *config.Account, *detect.Result, error) {
	name, acct, err := a.account()
	if err != nil {
		return nil, "", nil, nil, err
	}
	st, err := a.dataStore()
	if err != nil {
		return nil, "", nil, nil, err
	}
	det, err := a.detect(ctx, acct)
	if err != nil {
		return nil, "", nil, nil, err
	}
	a.logf("供应商判定: %s (%s:%d %s)", det.Provider, det.Host, det.Port, det.TLS)
	c, err := engine.Open(ctx, engine.Options{
		AccountName: name,
		Account:     acct,
		Det:         det,
		Store:       st,
		Timeout:     time.Duration(a.g.Timeout) * time.Second,
	})
	if err != nil {
		return nil, "", nil, nil, err
	}
	return c, name, acct, det, nil
}

// mapErr 将内部错误映射为统一错误信封
func mapErr(err error) *out.Error {
	if err == nil {
		return nil
	}
	if e, ok := err.(*out.Error); ok {
		return e
	}
	switch engine.KindOf(err) {
	case engine.KindAuth:
		e := out.Auth(err.Error())
		e.Hint = "检查账号密码/授权码，或执行 mail auth login 完成 OAuth 授权"
		return e
	case engine.KindNetwork:
		e := out.Network(err.Error())
		if strings.Contains(err.Error(), "certificate") || strings.Contains(err.Error(), "x509") {
			e.Hint = "系统缺少 CA 证书：安装 ca-certificates，或设置 SSL_CERT_FILE 指向证书包；仅测试环境可用 insecure_skip_verify = true"
		} else {
			e.Hint = "检查网络、端口与防火墙；可用 mail doctor 查看探测结果"
		}
		return e
	case engine.KindNotFound:
		return out.NotFound(err.Error())
	case engine.KindConfig:
		return out.Usage(err.Error())
	}
	return out.General(err.Error())
}

func (a *App) record(rec store.Record) {
	st, err := a.dataStore()
	if err != nil {
		return
	}
	if rec.Time.IsZero() {
		rec.Time = time.Now()
	}
	_ = st.Append(rec)
}

func (a *App) ctx() (context.Context, context.CancelFunc) {
	timeout := time.Duration(a.g.Timeout) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return context.WithTimeout(context.Background(), timeout)
}
