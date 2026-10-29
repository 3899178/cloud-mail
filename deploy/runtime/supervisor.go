// Linux supervisor: starts helper before Node, drains Node before helper, and
// never removes a pre-existing socket. Docker owns bounded whole-unit restarts.
package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func socketPath() string {
	if p := os.Getenv("PROTON_HELPER_SOCKET"); p != "" {
		return p
	}
	return "/run/cloud-mail-proton/helper.sock"
}
func probeHelper(path string) error {
	info, err := os.Lstat(filepath.Dir(path))
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("DIRECTORY_UNSAFE")
	}
	info, err = os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0600 {
		return errors.New("SOCKET_UNSAFE")
	}
	for _, p := range []string{filepath.Dir(path), path} {
		stat, e := os.Lstat(p)
		if e != nil {
			return e
		}
		if s, ok := stat.Sys().(*syscall.Stat_t); !ok || int(s.Uid) != os.Getuid() {
			return errors.New("SOCKET_OWNER")
		}
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: time.Second, Transport: transport}
	response, err := client.Post("http://unix/rpc", "application/octet-stream", bytes.NewBufferString("{\"op\":\"probe\",\"owner\":\"__probe\",\"account\":\"__probe\",\"session\":\"__probe\"}\n"))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 128))
	if err != nil || response.StatusCode != 502 || !bytes.Contains(body, []byte(`"error":"AUTH_REQUIRED"`)) {
		return errors.New("HELPER_NOT_READY")
	}
	return nil
}

type child struct {
	cmd  *exec.Cmd
	done chan error
}

func start(name string, args ...string) (*child, error) {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// Supervisor has its own small Go budget. Helper gets the configured budget.
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &child{cmd: cmd, done: make(chan error, 1)}
	go func() { c.done <- cmd.Wait(); close(c.done) }()
	return c, nil
}
func stop(c *child) {
	if c == nil {
		return
	}
	c.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-c.done:
	case <-time.After(10 * time.Second):
		c.cmd.Process.Kill()
		<-c.done
	}
}
func run() int {
	if os.Getuid() == 0 {
		return 1
	}
	path := socketPath()
	if !filepath.IsAbs(path) || len(path) > 100 {
		return 1
	}
	// Even a stale socket at startup is refused. A fresh private tmpfs/container
	// is the operator recovery; no PID guessing or unlink of another live process.
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return 1
	}
	h, err := start("/usr/local/bin/proton-helper")
	if err != nil {
		return 1
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	ready := false
	for i := 0; i < 100; i++ {
		if probeHelper(path) == nil {
			ready = true
			break
		}
		select {
		case <-h.done:
			return 1
		case <-signals:
			stop(h)
			return 0
		case <-time.After(100 * time.Millisecond):
		}
	}
	if !ready {
		stop(h)
		return 1
	}
	entry := "services/mail-sync/src/index.mjs"
	// A read-only acceptance fixture replaces Node rather than adding a second
	// V8 process to the combined cgroup. No fixture source ships in runtime.
	if len(os.Args) == 3 && os.Args[1] == "--node-entry" {
		entry = os.Args[2]
	}
	n, err := start("/usr/local/bin/node", "--max-old-space-size=96", entry)
	if err != nil {
		stop(h)
		return 1
	}
	code := 0
	select {
	case <-signals:
	case <-h.done:
		code = 1
	case err := <-n.done:
		if err != nil {
			code = 1
		}
	}
	stop(n)
	stop(h)
	// Both child Wait calls completed: only now may this supervisor remove its
	// own stale socket. Never follow a symlink or remove a substituted file.
	if info, e := os.Lstat(path); e == nil && info.Mode()&os.ModeSocket != 0 {
		os.Remove(path)
	}
	return code
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "health" {
		if probeHelper(socketPath()) != nil {
			os.Exit(1)
		}
		c := http.Client{Timeout: time.Second}
		r, e := c.Get("http://127.0.0.1:3211/health")
		if e != nil {
			os.Exit(1)
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	os.Setenv("GOMEMLIMIT", "24MiB")
	code := run()
	if code != 0 {
		os.Stderr.WriteString("MAIL_SYNC_UNIT_FAILED\n")
	}
	os.Exit(code)
}
