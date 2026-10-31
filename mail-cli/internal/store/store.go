package store

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Record 收发记录，追加写入 JSONL，便于 AI 直接 grep。
type Record struct {
	Time        time.Time `json:"time"`
	Direction   string    `json:"direction"` // in | out
	Account     string    `json:"account"`
	Provider    string    `json:"provider"`
	Folder      string    `json:"folder,omitempty"`
	ID          string    `json:"id,omitempty"`
	MessageID   string    `json:"message_id,omitempty"`
	From        string    `json:"from,omitempty"`
	To          []string  `json:"to,omitempty"`
	Subject     string    `json:"subject,omitempty"`
	Status      string    `json:"status"` // ok | error
	Error       string    `json:"error,omitempty"`
	Attachments int       `json:"attachments,omitempty"`
}

type State struct {
	LastUID   map[string]uint32    `json:"last_uid"`   // key: account/folder
	LastCheck map[string]time.Time `json:"last_check"` // key: account
}

// OAuthToken 持久化到 data_dir/oauth.json，避免回写配置文件。
type OAuthToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type,omitempty"`
	Scope        string    `json:"scope,omitempty"`
	Expiry       time.Time `json:"expiry"`
}

type Store struct {
	dir string
	mu  sync.Mutex
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

func (s *Store) Dir() string { return s.dir }

func (s *Store) recordsPath() string { return filepath.Join(s.dir, "records.jsonl") }
func (s *Store) statePath() string   { return filepath.Join(s.dir, "state.json") }
func (s *Store) oauthPath() string   { return filepath.Join(s.dir, "oauth.json") }

func (s *Store) Append(r Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Time.IsZero() {
		r.Time = time.Now()
	}
	f, err := os.OpenFile(s.recordsPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = f.Write(b)
	return err
}

// Tail 返回最近 n 条记录（旧→新）
func (s *Store) Tail(n int) ([]Record, error) {
	f, err := os.Open(s.recordsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []Record{}, nil
		}
		return nil, err
	}
	defer f.Close()
	var all []Record
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var r Record
		if err := json.Unmarshal(line, &r); err != nil {
			continue
		}
		all = append(all, r)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if n > 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	return all, nil
}

func (s *Store) LoadState() (*State, error) {
	st := &State{LastUID: map[string]uint32{}, LastCheck: map[string]time.Time{}}
	b, err := os.ReadFile(s.statePath())
	if err != nil {
		if os.IsNotExist(err) {
			return st, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, st); err != nil {
		return st, nil // 状态损坏不影响主流程
	}
	if st.LastUID == nil {
		st.LastUID = map[string]uint32{}
	}
	if st.LastCheck == nil {
		st.LastCheck = map[string]time.Time{}
	}
	return st, nil
}

func (s *Store) SaveState(st *State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.statePath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.statePath())
}

func (s *Store) LoadTokens() (map[string]OAuthToken, error) {
	out := map[string]OAuthToken{}
	b, err := os.ReadFile(s.oauthPath())
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return map[string]OAuthToken{}, nil
	}
	return out, nil
}

func (s *Store) SaveToken(account string, t OAuthToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens, err := s.LoadTokens()
	if err != nil {
		return err
	}
	tokens[account] = t
	b, err := json.MarshalIndent(tokens, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.oauthPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.oauthPath())
}

func (s *Store) GetToken(account string) (OAuthToken, bool, error) {
	tokens, err := s.LoadTokens()
	if err != nil {
		return OAuthToken{}, false, err
	}
	t, ok := tokens[account]
	return t, ok, nil
}

func (s *Store) DeleteToken(account string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens, err := s.LoadTokens()
	if err != nil {
		return err
	}
	delete(tokens, account)
	b, err := json.MarshalIndent(tokens, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.oauthPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.oauthPath())
}
