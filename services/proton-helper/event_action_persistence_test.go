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

func TestEventActionActualJSONAndNodePersistence(t *testing.T) {
	phase := "baseline"
	lists := 0
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/events/latest":
			json.NewEncoder(w).Encode(map[string]any{"Code": 1000, "EventID": "saved", "More": 0})
		case "/events/saved":
			change := map[string]any{"ID": "admitted"}
			switch phase {
			case "missing":
			case "null":
				change["Action"] = nil
			case "negative":
				change["Action"] = -1
			case "unknown":
				change["Action"] = 4
			case "string":
				change["Action"] = "0"
			case "fraction":
				change["Action"] = 0.5
			case "delete":
				change["Action"] = 0
			default:
				change["Action"] = 3
				change["Message"] = map[string]any{"Unread": 0}
			}
			json.NewEncoder(w).Encode(map[string]any{"Code": 1000, "EventID": "next", "More": 0, "Messages": []any{change}})
		case "/messages":
			lists++
			unread := 1
			if phase == "retry" {
				unread = 0
			}
			json.NewEncoder(w).Encode(map[string]any{"Code": 1000, "Total": 1, "Messages": []*pm.Message{{ID: "admitted", Type: pm.MessageInbox, Time: 1793100001, Unread: unread, LabelIDs: []string{"0"}}}})
		default:
			t.Error("unexpected provider operation", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer fixture.Close()
	s := &mailSession{api: &pm.Client{RootURL: fixture.URL, HTTPClient: fixture.Client()}}
	outcomes := map[string]json.RawMessage{}
	capture := func(name, cursor string) (snapshot, error) {
		got, err := s.snapshot(context.Background(), "0", cursor, 0)
		response := httptest.NewRecorder()
		respond(response, got, err)
		outcomes[name] = append(json.RawMessage(nil), response.Body.Bytes()...)
		return got, err
	}
	if _, err := capture("baseline", ""); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"missing", "null", "negative", "unknown", "string", "fraction"} {
		phase = mode
		t.Run(mode, func(t *testing.T) {
			before := lists
			got, err := capture(mode, "saved")
			if err == nil || got.Cursor != "" || len(got.Removed) != 0 || lists != before {
				t.Fatal("malformed action granted usable delta/cursor or metadata work", got, err, lists-before)
			}
		})
	}
	phase = "retry"
	if got, err := capture("retry", "saved"); err != nil || len(got.Messages) != 1 || got.Messages[0].Unread {
		t.Fatal(got, err)
	}
	phase = "delete"
	if got, err := capture("delete", "saved"); err != nil || len(got.Removed) != 1 || len(got.Messages) != 0 {
		t.Fatal(got, err)
	}
	node := os.Getenv("CLOUD_MAIL_TEST_NODE")
	if node == "" {
		node, _ = exec.LookPath("node")
	}
	if node == "" {
		t.Skip("Node executable unavailable; set CLOUD_MAIL_TEST_NODE for persistence bridge")
	}
	payload, err := json.Marshal(outcomes)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, "--test", filepath.Join("..", "mail-sync", "tests", "protocol", "proton-action-persistence.mjs"))
	cmd.Env = append(os.Environ(), "CLOUD_MAIL_ACTION_FIXTURE="+string(payload))
	output, err := cmd.CombinedOutput()
	t.Logf("Node persistence bridge:\n%s", output)
	if err != nil {
		t.Fatal("Node persistence bridge failed", err)
	}
}
