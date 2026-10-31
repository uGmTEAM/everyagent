package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecordsAndState(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Append(Record{Account: "a", Direction: "out", Status: "ok", Subject: "你好"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Append(Record{Account: "a", Direction: "in", Status: "ok", Subject: "world"}); err != nil {
		t.Fatal(err)
	}
	recs, err := s.Tail(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 || recs[1].Subject != "world" {
		t.Fatalf("records = %+v", recs)
	}
	if recs[0].Time.IsZero() {
		t.Error("time not filled")
	}

	st, err := s.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	st.LastUID["a/INBOX"] = 42
	st.LastCheck["a"] = time.Now()
	if err := s.SaveState(st); err != nil {
		t.Fatal(err)
	}
	st2, err := s.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if st2.LastUID["a/INBOX"] != 42 {
		t.Errorf("state = %+v", st2)
	}

	if _, err := os.Stat(filepath.Join(dir, "records.jsonl")); err != nil {
		t.Errorf("records file missing: %v", err)
	}
}

func TestTokens(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tok := OAuthToken{AccessToken: "a", RefreshToken: "r", Expiry: time.Now().Add(time.Hour)}
	if err := s.SaveToken("me", tok); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetToken("me")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if got.AccessToken != "a" || got.RefreshToken != "r" {
		t.Errorf("token = %+v", got)
	}
	if err := s.DeleteToken("me"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.GetToken("me"); ok {
		t.Error("token not deleted")
	}
}
