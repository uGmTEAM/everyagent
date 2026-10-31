package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// Account 单个邮箱账号配置。所有字段均可留空由自动识别补齐。
type Account struct {
	Email       string `toml:"email"`
	Username    string `toml:"username"`
	Password    string `toml:"password"`
	PasswordEnv string `toml:"password_env"`
	DisplayName string `toml:"display_name"`

	// auto / imap / gmail / graph
	Provider string `toml:"provider"`

	Host string `toml:"host"`
	Port int    `toml:"port"`
	TLS  string `toml:"tls"` // ssl / starttls / none

	SMTPHost string `toml:"smtp_host"`
	SMTPPort int    `toml:"smtp_port"`
	SMTPTLS  string `toml:"smtp_tls"`

	SentFolder string `toml:"sent_folder"`

	ClientID     string   `toml:"client_id"`
	ClientSecret string   `toml:"client_secret"`
	RefreshToken string   `toml:"refresh_token"`
	Tenant       string   `toml:"tenant"`
	Scopes       []string `toml:"scopes"`
	AuthURL      string   `toml:"auth_url"`
	TokenURL     string   `toml:"token_url"`
	DeviceURL    string   `toml:"device_url"`

	// Gmail / Graph 接口地址覆盖，便于私有化部署与测试
	APIBase string `toml:"api_base"`

	AttachDir string `toml:"attach_dir"`

	InsecureSkipVerify bool `toml:"insecure_skip_verify"`
}

type Config struct {
	DefaultAccount string              `toml:"default_account"`
	DataDir        string              `toml:"data_dir"`
	TimeoutSeconds int                 `toml:"timeout_seconds"`
	Accounts       map[string]*Account `toml:"accounts"`

	Path string `toml:"-"`
}

// DefaultSearchPaths 配置查找顺序
func DefaultSearchPaths() []string {
	paths := []string{}
	if p := os.Getenv("MAIL_CLI_CONFIG"); p != "" {
		paths = append(paths, p)
	}
	paths = append(paths, "/etc/mail-cli/config.toml")
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths,
			filepath.Join(home, ".config", "mail-cli", "config.toml"),
			filepath.Join(home, ".mail-cli", "config.toml"),
		)
	}
	return paths
}

func FindConfig(explicit string) (string, error) {
	if explicit != "" {
		if _, err := os.Stat(explicit); err != nil {
			return "", fmt.Errorf("配置文件不存在: %s", explicit)
		}
		return explicit, nil
	}
	for _, p := range DefaultSearchPaths() {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("未找到配置文件，可执行 mail init 生成模板，或用 --config 指定")
}

func Load(path string) (*Config, error) {
	cfg := &Config{TimeoutSeconds: 30}
	md, err := toml.DecodeFile(path, cfg)
	if err != nil {
		return nil, err
	}
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		// 仅提示，不阻断
		fmt.Fprintf(os.Stderr, "警告: 未知配置项 %v\n", undecoded)
	}
	cfg.Path = path
	if cfg.Accounts == nil {
		cfg.Accounts = map[string]*Account{}
	}
	for name, a := range cfg.Accounts {
		if a == nil {
			delete(cfg.Accounts, name)
			continue
		}
		a.applyDefaults()
	}
	if cfg.DataDir == "" {
		if d := os.Getenv("MAIL_CLI_DATA"); d != "" {
			cfg.DataDir = d
		} else if home, err := os.UserHomeDir(); err == nil {
			cfg.DataDir = filepath.Join(home, ".local", "share", "mail-cli")
		} else {
			cfg.DataDir = "/var/lib/mail-cli"
		}
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 30
	}
	return cfg, nil
}

func (a *Account) applyDefaults() {
	if a.Provider == "" {
		a.Provider = "auto"
	}
	if a.TLS == "" {
		a.TLS = "ssl"
	}
	if a.SMTPTLS == "" {
		a.SMTPTLS = "ssl"
	}
	if a.Username == "" {
		a.Username = a.Email
	}
}

// ResolvePassword 支持 password_env 间接引用，避免把授权码写进配置
func (a *Account) ResolvePassword() string {
	if a.PasswordEnv != "" {
		if v := os.Getenv(a.PasswordEnv); v != "" {
			return v
		}
	}
	return a.Password
}

// Account 解析账号名：空则用 default_account，唯一账号时自动选中
func (c *Config) Account(name string) (string, *Account, error) {
	if name == "" {
		name = c.DefaultAccount
	}
	if name == "" {
		if len(c.Accounts) == 1 {
			for k, v := range c.Accounts {
				return k, v, nil
			}
		}
		return "", nil, fmt.Errorf("未指定账号且未配置 default_account")
	}
	a, ok := c.Accounts[name]
	if !ok {
		return "", nil, fmt.Errorf("账号 %q 不存在", name)
	}
	return name, a, nil
}

func Template() string {
	return `# mail-cli 配置（多账号）
# 凭据为明文保存，请把本文件权限设为 600
default_account = "main"
# data_dir = "/var/lib/mail-cli"
timeout_seconds = 30

[accounts.main]
email = "you@example.com"
# 授权码或密码；也可用 password_env 指向环境变量
password = ""
# display_name = "张三"
# provider = "auto"        # auto | imap | gmail | graph
# host = ""                # 留空自动探测
# port = 993
# tls = "ssl"              # ssl | starttls | none
# smtp_host = ""
# smtp_port = 465
# smtp_tls = "ssl"
# sent_folder = ""         # 留空自动识别「已发送」
# attach_dir = ""          # 附件默认保存目录

# OAuth 账号（Gmail / Outlook）额外需要：
# client_id = ""
# client_secret = ""
# tenant = "common"        # 仅 Graph
# 首次登录：mail auth login --account main

[accounts.second]
email = "other@example.com"
password = ""
`
}
