package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type command struct {
	Op              string    `json:"op"`
	Owner           string    `json:"owner"`
	Account         string    `json:"account"`
	Username        string    `json:"username"`
	Password        string    `json:"password"`
	MailboxPassword string    `json:"mailboxPassword"`
	Code            string    `json:"code"`
	Challenge       string    `json:"challenge"`
	Material        *material `json:"material"`
	Session         string    `json:"session"`
	Folder          string    `json:"folder"`
	Cursor          string    `json:"cursor"`
	BaselineAt      int64     `json:"baselineAt"`
	ID              string    `json:"id"`
	Unread          bool      `json:"unread"`
	Recipients      []string  `json:"recipients"`
}

func readCommand(reader *bufio.Reader) (command, error) {
	var r command
	line, err := reader.ReadSlice('\n')
	if err != nil || len(line) > 65536 {
		return r, errCapacity
	}
	if err = json.Unmarshal(line, &r); err != nil {
		return r, errSync
	}
	if required(r.Owner, 128) != nil || required(r.Account, 128) != nil {
		return r, errUnauthorized
	}
	return r, nil
}
func respond(w http.ResponseWriter, value any, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		w.WriteHeader(502)
		value = map[string]string{"error": safeCode(err)}
	}
	json.NewEncoder(w).Encode(value)
}
func (h *helper) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || (r.URL.Path != "/rpc" && r.URL.Path != "/fetch" && r.URL.Path != "/send") {
		respond(w, nil, errSync)
		return
	}
	select {
	case h.admission <- struct{}{}:
		defer func() { <-h.admission }()
	default:
		respond(w, nil, errCapacity)
		return
	}
	reader := bufio.NewReaderSize(http.MaxBytesReader(w, r.Body, rawLimit+65536), 65536)
	cmd, err := readCommand(reader)
	if err != nil {
		respond(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 110*time.Second)
	defer cancel()
	if r.URL.Path == "/rpc" {
		// Control frames have exactly one JSON line and no ignored trailing bytes.
		if _, e := reader.ReadByte(); e != io.EOF {
			respond(w, nil, errCapacity)
			return
		}
		switch cmd.Op {
		case "auth.start":
			v, e := h.start(ctx, cmd)
			respond(w, v, e)
			return
		case "auth.complete":
			v, e := h.complete(ctx, cmd)
			respond(w, v, e)
			return
		case "open":
			v, e := h.open(ctx, cmd)
			respond(w, v, e)
			return
		case "cancel":
			h.cancel(cmd.Owner, cmd.Account)
			respond(w, map[string]bool{"ok": true}, nil)
			return
		}
	}
	s, err := h.session(cmd)
	if err != nil {
		respond(w, nil, err)
		return
	}
	// Each account's Node registry serializes operations. Helper additionally rejects overlap.
	if !s.busy.TryLock() {
		respond(w, nil, errCapacity)
		return
	}
	defer s.busy.Unlock()
	s.client.HTTPClient = httpClient(ctx)
	if r.URL.Path == "/fetch" || r.URL.Path == "/send" {
		select {
		case h.streaming <- struct{}{}:
			defer func() { <-h.streaming }()
		default:
			respond(w, nil, errCapacity)
			return
		}
		if r.URL.Path == "/fetch" {
			if cmd.Op != "fetch" || required(cmd.ID, 512) != nil {
				respond(w, nil, errSync)
				return
			}
			w.Header().Set("Content-Type", "message/rfc822")
			w.Header().Set("Cache-Control", "no-store")
			// Any error after output begins aborts the HTTP stream; no successful truncated MIME.
			if err = s.mime(ctx, cmd.ID, w); err != nil {
				panic(http.ErrAbortHandler)
			}
			return
		}
		if cmd.Op != "send" {
			respond(w, nil, errSync)
			return
		}
		err = s.send(ctx, reader, cmd.Recipients)
		respond(w, map[string]bool{"accepted": err == nil}, err)
		return
	}
	var value any = map[string]bool{"ok": true}
	switch cmd.Op {
	case "folders":
		f, e := s.folders()
		err = e
		value = map[string]any{"folders": f}
	case "snapshot":
		value, err = s.snapshot(ctx, cmd.Folder, cmd.Cursor, cmd.BaselineAt)
	case "validate":
		event, e := s.api.GetEvent(cmd.Cursor)
		err = e
		value = map[string]bool{"valid": e == nil && event != nil && event.ID == cmd.Cursor && len(event.Messages) == 0 && len(event.Labels) == 0 && event.More != nil && *event.More == 0 && event.Refresh == 0 && cmd.Cursor != ""}
	case "flags":
		if required(cmd.ID, 512) != nil {
			err = errSync
		} else {
			err = s.flags(cmd.ID, cmd.Unread)
		}
	case "trash":
		if required(cmd.ID, 512) != nil {
			err = errSync
		} else {
			err = s.trash(cmd.ID)
		}
	case "close":
		h.mu.Lock()
		delete(h.sessions, cmd.Session)
		h.mu.Unlock()
	default:
		err = errSync
	}
	respond(w, value, err)
}
func privateListener(socket string) (net.Listener, error) {
	if runtime.GOOS != "linux" || !filepath.IsAbs(socket) || len(socket) > 100 {
		return nil, errors.New("UNIX_SOCKET_REQUIRED")
	}
	directory := filepath.Dir(socket)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 || !ownedDirectory(info) {
		return nil, errUnauthorized
	}
	if existing, e := os.Lstat(socket); e == nil {
		if existing.Mode()&os.ModeSocket == 0 {
			return nil, errUnauthorized
		}
		return nil, errors.New("SOCKET_ALREADY_EXISTS")
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(socket, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}
func main() {
	// The pinned dependency logs raw API errors internally; discard all library logs.
	log.SetOutput(io.Discard)
	socket := os.Getenv("PROTON_HELPER_SOCKET")
	if strings.TrimSpace(socket) == "" {
		socket = "/run/cloud-mail-proton/helper.sock"
	}
	listener, err := privateListener(socket)
	if err != nil {
		os.Stderr.WriteString("PROTON_HELPER_START_FAILED\n")
		os.Exit(1)
	}
	server := &http.Server{Handler: newHelper(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 120 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 4096, ErrorLog: log.New(io.Discard, "", 0)}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stopped
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()
	server.Serve(listener)
}
