package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"mailcli/internal/engine"
	"mailcli/internal/out"
	"mailcli/internal/store"
)

type watchEvent struct {
	Type     string         `json:"type"`
	At       time.Time      `json:"at"`
	Account  string         `json:"account"`
	Provider string         `json:"provider"`
	Folder   string         `json:"folder"`
	Message  engine.Message `json:"message"`
}

// cmdWatch 轮询收件箱，新邮件以 NDJSON 事件输出，可触发外部命令
func (a *App) cmdWatch(args []string) (any, map[string]any, error) {
	fs := newFlagSet("watch")
	folder := "INBOX"
	interval := 60
	once := false
	execCmd := ""
	limit := 30
	fs.StringVar(&folder, "folder", "INBOX", "监听的文件夹")
	fs.IntVar(&interval, "interval", 60, "轮询间隔（秒）")
	fs.BoolVar(&once, "once", false, "只检查一次后退出")
	fs.StringVar(&execCmd, "exec", "", "收到新邮件时执行的 shell 命令")
	fs.IntVar(&limit, "limit", 30, "每轮最多检查的邮件数")
	a.addCommon(fs)
	if err := parseMixed(fs, args); err != nil {
		return nil, nil, out.Usage(err.Error())
	}
	if interval < 5 && !once {
		return nil, nil, out.Usage("--interval 不能小于 5 秒")
	}
	name, acct, err := a.account()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	st, err := a.dataStore()
	if err != nil {
		return nil, nil, mapErr(err)
	}
	state, _ := st.LoadState()
	key := name + "/" + folder

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	det, err := a.detect(ctx, acct)
	if err != nil {
		return nil, nil, mapErr(err)
	}

	lastUID := state.LastUID[key]
	_, hasUIDState := state.LastUID[key]
	firstRun := det.Provider == "imap" && !hasUIDState
	lastCheck := state.LastCheck[name]
	if lastCheck.IsZero() {
		// 首次运行以当前时间为基线，避免把历史邮件全部当作新邮件
		lastCheck = time.Now().Add(-time.Minute)
	}
	enc := json.NewEncoder(os.Stdout)
	emitted := 0

	for {
		client, err := engine.Open(ctx, engine.Options{
			AccountName: name,
			Account:     acct,
			Det:         det,
			Store:       st,
			Timeout:     time.Duration(a.g.Timeout) * time.Second,
		})
		if err != nil {
			emitWatchError(enc, name, det.Provider, err)
			if once {
				return nil, nil, mapErr(err)
			}
		} else {
			msgs, lerr := client.List(ctx, folder, engine.Query{Limit: limit, Folder: folder})
			client.Close()
			switch {
			case lerr != nil:
				emitWatchError(enc, name, det.Provider, lerr)
				if once {
					return nil, nil, mapErr(lerr)
				}
			case firstRun:
				// 首次运行只建立基线，不把存量邮件当作新邮件
				for _, m := range msgs {
					if uid, err := strconv.ParseUint(m.ID, 10, 32); err == nil && uint32(uid) > lastUID {
						lastUID = uint32(uid)
					}
				}
				firstRun = false
				state.LastUID[key] = lastUID
				state.LastCheck[name] = time.Now()
				_ = st.SaveState(state)
			default:
				emitted += a.emitNew(enc, ctx, name, folder, det.Provider, execCmd, msgs, &lastUID, &lastCheck)
				if det.Provider != "imap" {
					lastCheck = time.Now()
				}
				state.LastUID[key] = lastUID
				state.LastCheck[name] = lastCheck
				_ = st.SaveState(state)
			}
		}
		if once {
			break
		}
		select {
		case <-ctx.Done():
			return map[string]any{"events": emitted, "last_uid": lastUID}, map[string]any{"account": name, "provider": det.Provider}, nil
		case <-time.After(time.Duration(interval) * time.Second):
		}
	}
	return map[string]any{"events": emitted, "last_uid": lastUID}, map[string]any{"account": name, "provider": det.Provider}, nil
}

// emitNew 由旧到新输出新邮件事件，返回事件数量
func (a *App) emitNew(enc *json.Encoder, ctx context.Context, name, folder, provider, execCmd string, msgs []engine.Message, lastUID *uint32, lastCheck *time.Time) int {
	emitted := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if !isNewMessage(provider, m, *lastUID, *lastCheck) {
			continue
		}
		_ = enc.Encode(watchEvent{Type: "new_mail", At: time.Now(), Account: name, Provider: provider, Folder: folder, Message: m})
		emitted++
		a.record(store.Record{
			Direction:   "in",
			Account:     name,
			Provider:    provider,
			Folder:      folder,
			ID:          m.ID,
			MessageID:   m.MessageID,
			From:        m.From,
			To:          m.To,
			Subject:     m.Subject,
			Status:      "ok",
			Attachments: len(m.Attachments),
		})
		if execCmd != "" {
			runHook(ctx, execCmd, name, folder, m)
		}
		if uid, err := strconv.ParseUint(m.ID, 10, 32); err == nil && uint32(uid) > *lastUID {
			*lastUID = uint32(uid)
		}
		if m.Date.After(*lastCheck) {
			*lastCheck = m.Date
		}
	}
	return emitted
}

func isNewMessage(provider string, m engine.Message, lastUID uint32, lastCheck time.Time) bool {
	if provider == "imap" {
		uid, err := strconv.ParseUint(m.ID, 10, 32)
		if err != nil {
			return false
		}
		return uint32(uid) > lastUID
	}
	return m.Date.After(lastCheck)
}

func emitWatchError(enc *json.Encoder, account, provider string, err error) {
	_ = enc.Encode(map[string]any{
		"type":     "error",
		"at":       time.Now(),
		"account":  account,
		"provider": provider,
		"error":    err.Error(),
	})
}

func runHook(ctx context.Context, command, account, folder string, m engine.Message) {
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Env = append(os.Environ(),
		"MAIL_ACCOUNT="+account,
		"MAIL_FOLDER="+folder,
		"MAIL_ID="+m.ID,
		"MAIL_SUBJECT="+m.Subject,
		"MAIL_FROM="+m.From,
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "hook 执行失败: %v\n", err)
	}
}
