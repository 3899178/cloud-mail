package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	pm "github.com/emersion/hydroxide/protonmail"
)

type fetchCountingAPI struct {
	fixtureAPI
	calls int
}

func (f *fetchCountingAPI) GetMessage(id string) (*pm.Message, error) {
	f.calls++
	return f.fixtureAPI.GetMessage(id)
}

func TestFetchRejectsTrailingPayloadBeforeUpstream(t *testing.T) {
	api := &fetchCountingAPI{fixtureAPI: fixtureAPI{messages: []*pm.Message{{ID: "message", Body: "fixture", MIMEType: "text/plain"}}}}
	h := newHelper()
	h.sessions["fixture-session"] = &mailSession{api: api, client: &pm.Client{}, owner: "one", account: "account", expires: time.Now().Add(time.Minute).UnixMilli()}
	frame := `{"op":"fetch","owner":"one","account":"account","session":"fixture-session","id":"message"}` + "\ntrailing"
	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest("POST", "/fetch", strings.NewReader(frame)))
	if response.Code != 502 || api.calls != 0 {
		t.Fatalf("trailing fetch payload reached upstream: status=%d calls=%d", response.Code, api.calls)
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body["error"] != "CAPACITY_EXCEEDED" {
		t.Fatalf("unexpected safe rejection: %q", response.Body.String())
	}
}

type observedRequestBody struct {
	io.ReadCloser
	once sync.Once
	read chan struct{}
}

func (b *observedRequestBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.once.Do(func() { close(b.read) })
	}
	return n, err
}

// Separate the JSON chunk from its terminator. This forces the real HTTP/1.1
// handler to observe request EOF itself, rather than relying on read-ahead.
func TestFetchChunkedDisconnectCancelsUpstream(t *testing.T) {
	waiting, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(waiting)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-release:
		}
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	original := http.DefaultTransport
	http.DefaultTransport = fixtureRoute{target: target, base: original}
	defer func() { http.DefaultTransport = original }()
	c := &pm.Client{RootURL: "https://mail.proton.me/api"}
	h := newHelper()
	h.sessions["fixture-session"] = &mailSession{api: c, client: c, owner: "one", account: "account", expires: time.Now().Add(time.Minute).UnixMilli()}
	read := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = &observedRequestBody{ReadCloser: r.Body, read: read}
		h.ServeHTTP(w, r)
	}))
	defer func() {
		close(release)
		server.CloseClientConnections()
		server.Close()
	}()
	conn, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	frame := `{"op":"fetch","owner":"one","account":"account","session":"fixture-session","id":"wait"}` + "\n"
	fmt.Fprintf(conn, "POST /fetch HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\n", len(frame), frame)
	select {
	case <-read:
	case <-time.After(2 * time.Second):
		t.Fatal("helper did not read JSON chunk")
	}
	fmt.Fprint(conn, "0\r\n\r\n")
	select {
	case <-waiting:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request did not start")
	}
	conn.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Error("completed chunked fetch disconnect did not cancel upstream")
	}
}
