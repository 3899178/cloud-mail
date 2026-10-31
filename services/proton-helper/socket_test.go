package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestProtocolFrameBoundsScopeAndSanitizedErrors(t *testing.T) {
	h := newHelper()
	server := httptest.NewServer(h)
	defer server.Close()
	for _, input := range []string{strings.Repeat("x", 65537) + "\n", "{\"op\":\"folders\",\"owner\":\"one\",\"account\":\"one\",\"session\":\"SECRET\"}\n", "{\"op\":\"cancel\",\"owner\":\"one\",\"account\":\"one\"}\ntrailing"} {
		response, err := http.Post(server.URL+"/rpc", "application/octet-stream", strings.NewReader(input))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode == 200 || strings.Contains(string(body), "SECRET") {
			t.Fatal(response.StatusCode, string(body))
		}
	}
	reader := bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", 65537)), 65536)
	if _, err := readCommand(reader); err == nil {
		t.Fatal("oversized frame")
	}
}
func TestBoundedCopyCancellationAndLimits(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := copyBounded(ctx, io.Discard, strings.NewReader("bytes"), 100); err == nil {
		t.Fatal("cancel ignored")
	}
	if err := copyBounded(context.Background(), io.Discard, strings.NewReader("12345"), 4); err != errCapacity {
		t.Fatal(err)
	}
	w := &boundedWriter{w: io.Discard, max: 3}
	if _, err := w.Write([]byte("1234")); err != errCapacity {
		t.Fatal(err)
	}
}

type endlessReader struct{}

func (endlessReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

type maxChunkWriter struct{ size int }

func (w *maxChunkWriter) Write(p []byte) (int, error) {
	if len(p) > w.size {
		w.size = len(p)
	}
	return len(p), nil
}
func TestRawAndAttachmentStreamingCaps(t *testing.T) {
	for _, limit := range []int64{attachmentLimit, rawLimit} {
		w := &maxChunkWriter{}
		if err := copyBounded(context.Background(), w, endlessReader{}, limit); err != errCapacity {
			t.Fatal(err)
		}
		if w.size > 65536 {
			t.Fatal("unbounded chunk", w.size)
		}
	}
	reader := &hardLimitReader{reader: strings.NewReader("12345"), remaining: 4}
	if _, err := io.ReadAll(reader); err != errCapacity {
		t.Fatal("expanded payload not capped", err)
	}
}
func TestBoundedOutputSplitsLargeHeaderWrites(t *testing.T) {
	sink := &maxChunkWriter{}
	writer := &boundedWriter{w: sink, max: rawLimit}
	if _, err := writer.Write(make([]byte, 128*1024)); err != nil {
		t.Fatal(err)
	}
	if sink.size > 65536 {
		t.Fatal("large upstream write escaped bounded chunks", sink.size)
	}
}
func TestPrivateUnixSocketPermissionsAndHTTP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux Unix-socket execution is a mandatory CI gate; Windows does not prove socket permissions")
	}
	dir := filepath.Join(t.TempDir(), "private")
	path := filepath.Join(dir, "helper.sock")
	listener, err := privateListener(path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	for _, p := range []string{dir, path} {
		info, err := os.Lstat(p)
		if err != nil || info.Mode().Perm()&0077 != 0 {
			t.Fatal("not private", p, err)
		}
	}
	server := &http.Server{Handler: newHelper()}
	go server.Serve(listener)
	defer server.Close()
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}}
	response, err := client.Post("http://unix/rpc", "application/octet-stream", strings.NewReader("{\"op\":\"cancel\",\"owner\":\"one\",\"account\":\"account\"}\n"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var value map[string]bool
	if json.NewDecoder(response.Body).Decode(&value) != nil || !value["ok"] {
		t.Fatal("private protocol failed")
	}
	if _, err = privateListener(path); err == nil {
		t.Fatal("existing socket overwritten")
	}
	public := filepath.Join(t.TempDir(), "public")
	os.Mkdir(public, 0755)
	if _, err = privateListener(filepath.Join(public, "helper.sock")); err == nil {
		t.Fatal("public directory accepted")
	}
}
