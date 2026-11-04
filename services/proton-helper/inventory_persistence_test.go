package main

import (
	"context"
	"encoding/json"
	pm "github.com/emersion/hydroxide/protonmail"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestInventoryActualJSONAndNodePersistence(t *testing.T) {
	phase := "baseline"
	malformed := map[string]string{
		"missing-all":      `{"Code":1000}`,
		"null-envelope":    `null`,
		"missing-total":    `{"Code":1000,"Messages":[]}`,
		"null-total":       `{"Code":1000,"Total":null,"Messages":[]}`,
		"missing-messages": `{"Code":1000,"Total":0}`,
		"null-messages":    `{"Code":1000,"Total":0,"Messages":null}`,
		"missing-code":     `{"Total":0,"Messages":[]}`,
		"null-code":        `{"Code":null,"Total":0,"Messages":[]}`,
		"failed-code":      `{"Code":999,"Total":0,"Messages":[]}`,
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/events/latest":
			json.NewEncoder(w).Encode(map[string]any{"Code": 1000, "EventID": phase, "More": 0})
		case "/messages":
			if raw, exists := malformed[phase]; exists {
				w.Write([]byte(raw))
				return
			}
			messages := []*pm.Message{{ID: "admitted", Type: pm.MessageInbox, Time: 1793100001, Unread: 1, LabelIDs: []string{"0"}}}
			total := 1
			if phase == "retry" {
				messages[0].Unread = 0
			}
			if phase == "empty" {
				total = 0
				messages = []*pm.Message{}
			}
			if phase == "changing-total" {
				if r.URL.Query().Get("Page") == "1" {
					messages = []*pm.Message{}
				} else {
					total = 2
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"Code": 1000, "Total": total, "Messages": messages})
		default:
			t.Error("unexpected provider path", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer fixture.Close()
	s := &mailSession{api: &pm.Client{RootURL: fixture.URL, HTTPClient: fixture.Client()}}
	outcomes := map[string]json.RawMessage{}
	capture := func(name string) (snapshot, error) {
		got, err := s.snapshot(context.Background(), "0", "", 0)
		response := httptest.NewRecorder()
		respond(response, got, err)
		outcomes[name] = append(json.RawMessage(nil), response.Body.Bytes()...)
		return got, err
	}
	if got, err := capture("baseline"); err != nil || len(got.Messages) != 1 {
		t.Fatal(got, err)
	}
	for _, mode := range []string{"missing-all", "null-envelope", "missing-total", "null-total", "missing-messages", "null-messages", "missing-code", "null-code", "failed-code", "changing-total"} {
		phase = mode
		t.Run(mode, func(t *testing.T) {
			if got, err := capture(mode); err == nil {
				t.Error("incomplete inventory granted successful full sweep", got)
			}
		})
	}
	phase = "retry"
	if got, err := capture("retry"); err != nil || len(got.Messages) != 1 || got.Messages[0].Unread {
		t.Fatal(got, err)
	}
	phase = "empty"
	if got, err := capture("empty"); err != nil || len(got.Messages) != 0 {
		t.Fatal(got, err)
	}
	node := os.Getenv("CLOUD_MAIL_TEST_NODE")
	if node == "" {
		node, _ = exec.LookPath("node")
	}
	if node == "" {
		t.Fatal("Node is required for the inventory persistence regression")
	}
	payload, err := json.Marshal(outcomes)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, "--test", "--test-reporter=tap", filepath.Join("..", "mail-sync", "tests", "protocol", "proton-inventory-persistence.mjs"))
	cmd.Env = append(os.Environ(), "CLOUD_MAIL_INVENTORY_FIXTURE="+string(payload))
	output, err := cmd.CombinedOutput()
	t.Logf("Node inventory persistence bridge:\n%s", output)
	if err != nil {
		t.Fatal("inventory persistence bridge failed", err)
	}
}
