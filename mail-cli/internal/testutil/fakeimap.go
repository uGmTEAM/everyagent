// Package testutil 提供测试用的极简 IMAP / SMTP 服务端，仅覆盖 mail-cli 使用的命令。
package testutil

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/mail"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type FakeMessage struct {
	UID       uint32
	Flags     map[string]bool
	Raw       []byte
	Date      time.Time
	Subject   string
	FromName  string
	FromMail  string
	FromHost  string
	To        []string
	MessageID string
}

type IMAP struct {
	ln       net.Listener
	mu       sync.Mutex
	nextUID  uint32
	messages []*FakeMessage
	appended [][]byte
}

func NewIMAP() (*IMAP, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	f := &IMAP{ln: ln, nextUID: 1}
	go f.serve()
	return f, nil
}

func (f *IMAP) Addr() (string, int) {
	addr := f.ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port
}

func (f *IMAP) Close() { _ = f.ln.Close() }

func (f *IMAP) Appended() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.appended)
}

func (f *IMAP) AppendedRaw() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte{}, f.appended...)
}

// Seed 投递一封邮件到 INBOX
func (f *IMAP) Seed(raw []byte, seen bool) uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := &FakeMessage{UID: f.nextUID, Flags: map[string]bool{}, Raw: raw, Date: time.Now()}
	f.nextUID++
	if seen {
		m.Flags["\\Seen"] = true
	}
	if pm, err := mail.ReadMessage(bytes.NewReader(raw)); err == nil {
		m.Subject = pm.Header.Get("Subject")
		if a, err := mail.ParseAddress(pm.Header.Get("From")); err == nil {
			m.FromName, m.FromMail = a.Name, a.Address
		}
		if i := strings.LastIndex(m.FromMail, "@"); i > 0 {
			m.FromHost = m.FromMail[i+1:]
			m.FromMail = m.FromMail[:i]
		}
		if list, err := mail.ParseAddressList(pm.Header.Get("To")); err == nil {
			for _, x := range list {
				m.To = append(m.To, x.Address)
			}
		}
		m.MessageID = pm.Header.Get("Message-Id")
		if d, err := mail.ParseDate(pm.Header.Get("Date")); err == nil {
			m.Date = d
		}
	}
	f.messages = append(f.messages, m)
	return m.UID
}

func (f *IMAP) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

func (f *IMAP) handle(conn net.Conn) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	fmt.Fprint(conn, "* OK [CAPABILITY IMAP4rev1 ID UIDPLUS] fake imap ready\r\n")
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 3)
		if len(parts) < 2 {
			continue
		}
		tag, cmd := parts[0], strings.ToUpper(parts[1])
		rest := ""
		if len(parts) == 3 {
			rest = parts[2]
		}
		switch cmd {
		case "CAPABILITY":
			fmt.Fprint(conn, "* CAPABILITY IMAP4rev1 ID UIDPLUS\r\n")
			fmt.Fprintf(conn, "%s OK CAPABILITY completed\r\n", tag)
		case "LOGIN":
			if strings.Contains(rest, "badpass") {
				fmt.Fprintf(conn, "%s NO [AUTHENTICATIONFAILED] invalid credentials\r\n", tag)
				continue
			}
			fmt.Fprintf(conn, "%s OK LOGIN completed\r\n", tag)
		case "ID":
			fmt.Fprint(conn, "* ID (\"name\" \"fake-imap\")\r\n")
			fmt.Fprintf(conn, "%s OK ID completed\r\n", tag)
		case "LIST":
			fmt.Fprint(conn, "* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n")
			fmt.Fprint(conn, "* LIST (\\HasNoChildren \\Sent) \"/\" \"Sent Messages\"\r\n")
			fmt.Fprintf(conn, "%s OK LIST completed\r\n", tag)
		case "SELECT", "EXAMINE":
			f.mu.Lock()
			n := len(f.messages)
			next := f.nextUID
			f.mu.Unlock()
			fmt.Fprint(conn, "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n")
			fmt.Fprintf(conn, "* %d EXISTS\r\n", n)
			fmt.Fprint(conn, "* 0 RECENT\r\n")
			fmt.Fprint(conn, "* OK [UIDVALIDITY 1] UIDs valid\r\n")
			fmt.Fprintf(conn, "* OK [UIDNEXT %d] Predicted next UID\r\n", next)
			fmt.Fprint(conn, "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited\r\n")
			fmt.Fprintf(conn, "%s OK [READ-WRITE] SELECT completed\r\n", tag)
		case "UID":
			f.handleUID(conn, tag, rest)
		case "APPEND":
			f.handleAppend(conn, br, tag, rest)
		case "NOOP", "CHECK":
			fmt.Fprintf(conn, "%s OK %s completed\r\n", tag, cmd)
		case "LOGOUT":
			fmt.Fprint(conn, "* BYE logging out\r\n")
			fmt.Fprintf(conn, "%s OK LOGOUT completed\r\n", tag)
			return
		default:
			fmt.Fprintf(conn, "%s OK %s completed\r\n", tag, cmd)
		}
	}
}

func (f *IMAP) handleUID(conn net.Conn, tag, rest string) {
	sub := strings.ToUpper(rest)
	switch {
	case strings.HasPrefix(sub, "SEARCH"):
		unseenOnly := strings.Contains(sub, "UNSEEN")
		f.mu.Lock()
		var uids []int
		for _, m := range f.messages {
			if unseenOnly && m.Flags["\\Seen"] {
				continue
			}
			uids = append(uids, int(m.UID))
		}
		f.mu.Unlock()
		sort.Ints(uids)
		var b strings.Builder
		b.WriteString("* SEARCH")
		for _, u := range uids {
			fmt.Fprintf(&b, " %d", u)
		}
		b.WriteString("\r\n")
		fmt.Fprint(conn, b.String())
		fmt.Fprintf(conn, "%s OK SEARCH completed\r\n", tag)
	case strings.HasPrefix(sub, "FETCH"):
		f.fetch(conn, tag, rest)
	case strings.HasPrefix(sub, "STORE"):
		f.store(conn, tag, rest)
	default:
		fmt.Fprintf(conn, "%s OK UID completed\r\n", tag)
	}
}

func (f *IMAP) fetch(conn net.Conn, tag, rest string) {
	fields := strings.Fields(rest)
	if len(fields) < 3 {
		fmt.Fprintf(conn, "%s BAD fetch syntax\r\n", tag)
		return
	}
	wantBody := strings.Contains(strings.ToUpper(rest), "BODY")
	set := parseUIDSet(fields[1])
	f.mu.Lock()
	var msgs []*FakeMessage
	seqs := map[uint32]int{}
	for i, m := range f.messages {
		seqs[m.UID] = i + 1
		if set[int(m.UID)] {
			msgs = append(msgs, m)
		}
	}
	f.mu.Unlock()
	for _, m := range msgs {
		var b bytes.Buffer
		fmt.Fprintf(&b, "* %d FETCH (UID %d FLAGS (%s) RFC822.SIZE %d INTERNALDATE \"%s\" ENVELOPE %s",
			seqs[m.UID], m.UID, flagsString(m.Flags), len(m.Raw), m.Date.Format("02-Jan-2006 15:04:05 -0700"), envelopeOf(m))
		if wantBody {
			fmt.Fprintf(&b, " BODY[] {%d}\r\n", len(m.Raw))
			b.Write(m.Raw)
		}
		b.WriteString(")\r\n")
		if _, err := conn.Write(b.Bytes()); err != nil {
			return
		}
	}
	fmt.Fprintf(conn, "%s OK FETCH completed\r\n", tag)
}

func (f *IMAP) store(conn net.Conn, tag, rest string) {
	fields := strings.Fields(rest)
	if len(fields) < 4 {
		fmt.Fprintf(conn, "%s BAD store syntax\r\n", tag)
		return
	}
	set := parseUIDSet(fields[1])
	op := strings.ToUpper(fields[2])
	flagPart := rest[strings.Index(rest, "("):]
	flagPart = strings.Trim(flagPart, "()")
	f.mu.Lock()
	for i, m := range f.messages {
		if !set[int(m.UID)] {
			continue
		}
		for _, fl := range strings.Fields(flagPart) {
			if strings.HasPrefix(op, "+") {
				m.Flags[fl] = true
			} else if strings.HasPrefix(op, "-") {
				delete(m.Flags, fl)
			}
		}
		fmt.Fprintf(conn, "* %d FETCH (UID %d FLAGS (%s))\r\n", i+1, m.UID, flagsString(m.Flags))
	}
	f.mu.Unlock()
	fmt.Fprintf(conn, "%s OK STORE completed\r\n", tag)
}

func (f *IMAP) handleAppend(conn net.Conn, br *bufio.Reader, tag, rest string) {
	idx := strings.LastIndex(rest, "{")
	if idx < 0 {
		fmt.Fprintf(conn, "%s BAD append syntax\r\n", tag)
		return
	}
	n, err := strconv.Atoi(strings.TrimSuffix(rest[idx+1:], "}"))
	if err != nil {
		fmt.Fprintf(conn, "%s BAD literal\r\n", tag)
		return
	}
	fmt.Fprint(conn, "+ Ready for literal data\r\n")
	raw := make([]byte, n)
	if _, err := io.ReadFull(br, raw); err != nil {
		return
	}
	_, _ = br.ReadString('\n')
	f.mu.Lock()
	f.appended = append(f.appended, raw)
	f.nextUID++
	f.mu.Unlock()
	fmt.Fprintf(conn, "%s OK APPEND completed\r\n", tag)
}

func flagsString(flags map[string]bool) string {
	var out []string
	for _, k := range []string{"\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"} {
		if flags[k] {
			out = append(out, k)
		}
	}
	return strings.Join(out, " ")
}

func parseUIDSet(s string) map[int]bool {
	out := map[int]bool{}
	for _, part := range strings.Split(s, ",") {
		if i := strings.Index(part, ":"); i > 0 {
			a, _ := strconv.Atoi(part[:i])
			b, _ := strconv.Atoi(part[i+1:])
			if a > b {
				a, b = b, a
			}
			for u := a; u <= b; u++ {
				out[u] = true
			}
			continue
		}
		if v, err := strconv.Atoi(part); err == nil {
			out[v] = true
		}
	}
	return out
}

func envelopeOf(m *FakeMessage) string {
	addr := "NIL"
	if m.FromMail != "" {
		addr = "((" + quoteIMAP(m.FromName) + " NIL " + quoteIMAP(m.FromMail) + " " + quoteIMAP(m.FromHost) + "))"
	}
	to := "NIL"
	if len(m.To) > 0 {
		var items []string
		for _, a := range m.To {
			mb, host := a, ""
			if i := strings.LastIndex(a, "@"); i > 0 {
				mb, host = a[:i], a[i+1:]
			}
			items = append(items, "(\"\" NIL "+quoteIMAP(mb)+" "+quoteIMAP(host)+")")
		}
		to = "(" + strings.Join(items, " ") + ")"
	}
	date := m.Date.Format("02-Jan-2006 15:04:05 -0700")
	return "(" + quoteIMAP(date) + " " + quoteIMAP(m.Subject) + " " + addr + " " + addr + " " + addr + " " + to + " NIL NIL NIL " + quoteIMAP(m.MessageID) + ")"
}

func quoteIMAP(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\"", "\\\"")
	return "\"" + s + "\""
}

type SMTP struct {
	ln   net.Listener
	mu   sync.Mutex
	msgs [][]byte
}

func NewSMTP() (*SMTP, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &SMTP{ln: ln}
	go s.serve()
	return s, nil
}

func (s *SMTP) Addr() (string, int) {
	a := s.ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", a.Port
}

func (s *SMTP) Close() { _ = s.ln.Close() }

func (s *SMTP) Messages() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([][]byte{}, s.msgs...)
}

func (s *SMTP) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *SMTP) handle(conn net.Conn) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	fmt.Fprint(conn, "220 fake ESMTP\r\n")
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			fmt.Fprint(conn, "250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n")
		case strings.HasPrefix(cmd, "AUTH"):
			fmt.Fprint(conn, "235 Authentication successful\r\n")
		case strings.HasPrefix(cmd, "MAIL FROM"):
			fmt.Fprint(conn, "250 OK\r\n")
		case strings.HasPrefix(cmd, "RCPT TO"):
			fmt.Fprint(conn, "250 OK\r\n")
		case cmd == "DATA":
			fmt.Fprint(conn, "354 End data with <CR><LF>.<CR><LF>\r\n")
			var buf bytes.Buffer
			for {
				l, err := br.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" || l == ".\n" {
					break
				}
				buf.WriteString(l)
			}
			s.mu.Lock()
			s.msgs = append(s.msgs, buf.Bytes())
			s.mu.Unlock()
			fmt.Fprint(conn, "250 OK queued\r\n")
		case cmd == "QUIT":
			fmt.Fprint(conn, "221 Bye\r\n")
			return
		default:
			fmt.Fprint(conn, "250 OK\r\n")
		}
	}
}
