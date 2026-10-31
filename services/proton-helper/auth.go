package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	pm "github.com/emersion/hydroxide/protonmail"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type material struct {
	Auth            *pm.Auth          `json:"auth"`
	KeySalts        map[string][]byte `json:"keySalts"`
	MailboxPassword string            `json:"mailboxPassword"`
}
type pendingAuth struct {
	client               *pm.Client
	auth                 *pm.Auth
	mailbox              string
	step, owner, account string
	expires              int64
}
type helper struct {
	mu         sync.Mutex
	challenges map[string]*pendingAuth
	sessions   map[string]*mailSession
	now        func() int64
	admission  chan struct{}
	streaming  chan struct{}
	newClient  func(context.Context) *pm.Client
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("random unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func newHelper() *helper {
	return &helper{challenges: map[string]*pendingAuth{}, sessions: map[string]*mailSession{}, now: func() int64 { return time.Now().UnixMilli() }, admission: make(chan struct{}, 2), streaming: make(chan struct{}, 1), newClient: clientFor}
}
func (h *helper) expire() {
	for k, v := range h.challenges {
		if v.expires <= h.now() {
			delete(h.challenges, k)
		}
	}
	for k, v := range h.sessions {
		if v.expires <= h.now() {
			delete(h.sessions, k)
		}
	}
}
func (h *helper) addChallenge(owner, account string, p *pendingAuth) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expire()
	for k, v := range h.challenges {
		if v.owner == owner && v.account == account {
			delete(h.challenges, k)
		}
	}
	if len(h.challenges) >= 16 {
		return "", errCapacity
	}
	p.owner = owner
	p.account = account
	p.expires = h.now() + 300000
	token := randomToken()
	h.challenges[token] = p
	return token, nil
}
func (h *helper) takeChallenge(owner, account, token string) (*pendingAuth, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expire()
	p := h.challenges[token]
	if p == nil || p.owner != owner || p.account != account {
		return nil, errUnauthorized
	}
	delete(h.challenges, token)
	return p, nil
}
func (h *helper) cancel(owner, account string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, p := range h.challenges {
		if p.owner == owner && p.account == account {
			delete(h.challenges, k)
		}
	}
	for k, s := range h.sessions {
		if s.owner == owner && s.account == account {
			delete(h.sessions, k)
		}
	}
}
func (h *helper) finish(ctx context.Context, owner, account string, p *pendingAuth) (map[string]any, error) {
	if p.auth.PasswordMode == pm.PasswordTwo && p.mailbox == "" {
		p.step = "mailbox-password"
		token, err := h.addChallenge(owner, account, p)
		return map[string]any{"step": p.step, "challenge": token}, err
	}
	salts, err := p.client.ListKeySalts()
	if err != nil {
		return nil, err
	}
	if _, err = p.client.Unlock(p.auth, salts, p.mailbox); err != nil {
		return nil, errAuth
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	m := material{p.auth, salts, p.mailbox}
	b, err := json.Marshal(m)
	if err != nil || len(b) > 16384 {
		return nil, errCapacity
	}
	return map[string]any{"material": m}, nil
}
func (h *helper) start(ctx context.Context, r command) (map[string]any, error) {
	if required(r.Username, 320) != nil || required(r.Password, 8192) != nil || len(r.MailboxPassword) > 8192 {
		return nil, errAuth
	}
	c := h.newClient(ctx)
	auth, err := c.Auth(r.Username, r.Password, nil, nil)
	if err != nil {
		var hv *pm.HumanVerificationRequiredError
		if errors.As(err, &hv) {
			return map[string]any{"step": "manual-verification", "reason": "HUMAN_VERIFICATION_REQUIRED"}, nil
		}
		return nil, errAuth
	}
	p := &pendingAuth{client: c, auth: auth, mailbox: r.MailboxPassword}
	if auth.PasswordMode == pm.PasswordSingle && p.mailbox == "" {
		p.mailbox = r.Password
	}
	if auth.TwoFactor.Enabled != 0 {
		if auth.TwoFactor.TOTP == 0 {
			return map[string]any{"step": "unsupported-challenge", "reason": "UNSUPPORTED_CHALLENGE"}, nil
		}
		p.step = "totp"
		token, err := h.addChallenge(r.Owner, r.Account, p)
		return map[string]any{"step": "totp", "challenge": token}, err
	}
	return h.finish(ctx, r.Owner, r.Account, p)
}
func (h *helper) complete(ctx context.Context, r command) (map[string]any, error) {
	p, err := h.takeChallenge(r.Owner, r.Account, r.Challenge)
	if err != nil {
		return nil, err
	}
	// A new request supplies a new cancellation context; no old request context is reused.
	p.client.HTTPClient = httpClient(ctx)
	switch p.step {
	case "totp":
		if len(r.Code) < 6 || len(r.Code) > 8 {
			return nil, errAuth
		}
		if _, err = p.client.AuthTOTP(r.Code); err != nil {
			return nil, errAuth
		}
	case "mailbox-password":
		if required(r.MailboxPassword, 8192) != nil {
			return nil, errAuth
		}
		p.mailbox = r.MailboxPassword
	default:
		return nil, errAuth
	}
	return h.finish(ctx, r.Owner, r.Account, p)
}
func (h *helper) open(ctx context.Context, r command) (map[string]any, error) {
	if r.Material == nil || r.Material.Auth == nil || r.Material.MailboxPassword == "" {
		return nil, errAuth
	}
	c := h.newClient(ctx)
	auth, err := c.AuthRefresh(r.Material.Auth)
	if err != nil {
		return nil, errAuth
	}
	keys, err := c.Unlock(auth, r.Material.KeySalts, r.Material.MailboxPassword)
	if err != nil {
		return nil, errAuth
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	r.Material.Auth = auth
	b, err := json.Marshal(r.Material)
	if err != nil || len(b) > 16384 {
		return nil, errCapacity
	}
	expires := auth.ExpiresAt.Add(-time.Minute).UnixMilli()
	if expires <= h.now() {
		return nil, errAuth
	}
	if expires > h.now()+600000 {
		expires = h.now() + 600000
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expire()
	for k, s := range h.sessions {
		if s.owner == r.Owner && s.account == r.Account {
			delete(h.sessions, k)
		}
	}
	if len(h.sessions) >= 50 {
		return nil, errCapacity
	}
	token := randomToken()
	h.sessions[token] = &mailSession{api: c, client: c, keys: keys, owner: r.Owner, account: r.Account, expires: expires}
	return map[string]any{"session": token, "material": r.Material, "expiresAt": expires}, nil
}
func (h *helper) session(r command) (*mailSession, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expire()
	s := h.sessions[r.Session]
	if s == nil || s.owner != r.Owner || s.account != r.Account {
		return nil, errAuth
	}
	return s, nil
}

type contextTransport struct{ ctx context.Context }
type limitedBody struct {
	io.ReadCloser
	remaining int64
}

func (b *limitedBody) Read(p []byte) (int, error) {
	if b.remaining <= 0 {
		return 0, errCapacity
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, e := b.ReadCloser.Read(p)
	b.remaining -= int64(n)
	return n, e
}
func (t contextTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || r.URL.Host != "mail.proton.me" {
		return nil, errAuth
	}
	response, err := http.DefaultTransport.RoundTrip(r.Clone(t.ctx))
	if err != nil {
		return nil, err
	}
	limit := int64(2 * 1024 * 1024)
	if strings.Contains(r.URL.Path, "/auth") {
		limit = 65536
	}
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/messages/") {
		limit = 40 * 1024 * 1024
	}
	if strings.HasPrefix(r.URL.Path, "/api/attachments/") {
		limit = rawLimit
	}
	if response.ContentLength > limit {
		response.Body.Close()
		return nil, errCapacity
	}
	response.Body = &limitedBody{response.Body, limit}
	return response, nil
}
func httpClient(ctx context.Context) *http.Client {
	return &http.Client{Transport: contextTransport{ctx}, Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errAuth }}
}
func clientFor(ctx context.Context) *pm.Client {
	return &pm.Client{RootURL: "https://mail.proton.me/api", AppVersion: "Other", HTTPClient: httpClient(ctx)}
}
