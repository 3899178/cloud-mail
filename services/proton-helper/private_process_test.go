package main

import (
	"context"
	"encoding/json"
	"fmt"
	pm "github.com/emersion/hydroxide/protonmail"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureRoute struct {
	target *url.URL
	base   http.RoundTripper
}

func (f fixtureRoute) RoundTrip(r *http.Request) (*http.Response, error) {
	c := r.Clone(r.Context())
	u := *r.URL
	u.Scheme = f.target.Scheme
	u.Host = f.target.Host
	u.Path = strings.TrimPrefix(u.Path, "/api")
	c.URL = &u
	return f.base.RoundTrip(c)
}

// Test-only child uses the production helper HTTP handler/privateListener and
// pinned HTTP client against a local provider. No fixture switch ships in main.
func TestUnixProcessFixtureChild(t *testing.T) {
	if os.Getenv("CLOUD_MAIL_UNIX_CHILD") != "1" {
		return
	}
	log.SetOutput(io.Discard)
	dir := os.Getenv("CLOUD_MAIL_UNIX_DIR")
	var sent atomic.Int64
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/messages/wait":
			os.WriteFile(filepath.Join(dir, "waiting"), []byte("1"), 0600)
			<-r.Context().Done()
			os.WriteFile(filepath.Join(dir, "cancelled-before"), []byte("1"), 0600)
			return
		case "/messages/stream":
			json.NewEncoder(w).Encode(map[string]any{"Code": 1000, "Message": &pm.Message{ID: "stream", Body: "fixture", MIMEType: "text/plain", Attachments: []*pm.Attachment{{ID: "large", Name: "large.bin", MIMEType: "application/octet-stream", Size: 25 * 1024 * 1024}}}})
		case "/attachments/large":
			block := make([]byte, 65536)
			for i := 0; i < 400; i++ {
				if _, err := w.Write(block); err != nil {
					os.WriteFile(filepath.Join(dir, "cancelled-stream"), []byte("1"), 0600)
					return
				}
				sent.Add(65536)
				os.WriteFile(filepath.Join(dir, "progress"), []byte(fmt.Sprint(sent.Load())), 0600)
			}
		default:
			w.WriteHeader(500)
		}
	}))
	defer api.Close()
	target, _ := url.Parse(api.URL)
	http.DefaultTransport = fixtureRoute{target: target, base: http.DefaultTransport}
	c := &pm.Client{RootURL: "https://mail.proton.me/api"}
	h := newHelper()
	h.sessions["fixture-session"] = &mailSession{api: c, client: c, owner: "one", account: "account", expires: time.Now().UnixMilli() + 600000}
	listener, err := privateListener(filepath.Join(dir, "helper.sock"))
	if err != nil {
		os.Exit(22)
	}
	server := &http.Server{Handler: h, ErrorLog: log.New(io.Discard, "", 0), ReadHeaderTimeout: time.Second}
	server.Serve(listener)
}
func TestLinuxNodePrivateProcess(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("actual private process integration requires Linux")
	}
	node := os.Getenv("CLOUD_MAIL_TEST_NODE")
	if node == "" {
		t.Fatal("CLOUD_MAIL_TEST_NODE required; never skip bridge")
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, "../../deploy/fixtures/private-process.mjs")
	command.Env = append(os.Environ(), "CLOUD_MAIL_UNIX_TEST_BINARY="+binary)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), "PRIVATE_PROCESS_PASSED") {
		t.Fatal("missing process assertions")
	}
}
