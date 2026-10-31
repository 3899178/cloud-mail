package main

import (
	"context"
	"encoding/json"
	pm "github.com/emersion/hydroxide/protonmail"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIncrementalMetadataActualAPIUnchangedAndPaginatedChanges(t *testing.T) {
	lists, events, bodies := 0, 0, 0
	phase := "baseline"
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{"Code": 1000, "More": 0}
		switch r.URL.Path {
		case "/events/latest":
			out["EventID"] = "e1"
		case "/events/e1":
			events++
			if phase == "baseline" {
				out["EventID"] = "e1"
			} else {
				out["EventID"] = "e2"
				out["More"] = 1
				out["Messages"] = []any{map[string]any{"ID": "history", "Action": 3, "Message": map[string]any{"Unread": 0}}, map[string]any{"ID": "gone", "Action": 0}}
			}
		case "/events/e2":
			events++
			out["EventID"] = "e3"
			out["More"] = 0
			out["Messages"] = []any{map[string]any{"ID": "new-old-date", "Action": 1, "Message": map[string]any{"ID": "new-old-date", "Type": 0, "Time": 1, "LabelIDs": []string{"0"}}}}
		case "/messages":
			lists++
			if phase == "baseline" {
				out["Messages"] = []*pm.Message{{ID: "history", Type: pm.MessageInbox, Time: 1, Unread: 1, LabelIDs: []string{"0"}}, {ID: "gone", Type: pm.MessageInbox, Time: 1, LabelIDs: []string{"0"}}}
				out["Total"] = 2
			} else {
				ids := r.URL.Query()["IDs[]"]
				if len(ids) != 2 {
					t.Error("changed metadata must use exact ID filter", r.URL.RawQuery)
				}
				out["Messages"] = []*pm.Message{{ID: "history", Type: pm.MessageInbox, Time: 1, Unread: 0, LabelIDs: []string{"0"}}, {ID: "new-old-date", Type: pm.MessageInbox, Time: 1, Unread: 1, LabelIDs: []string{"0"}}}
				out["Total"] = 2
			}
		default:
			bodies++
			t.Error("unexpected request", r.URL.Path)
			w.WriteHeader(500)
			return
		}
		json.NewEncoder(w).Encode(out)
	}))
	defer fixture.Close()
	s := &mailSession{api: &pm.Client{RootURL: fixture.URL, HTTPClient: fixture.Client()}}
	first, err := s.snapshot(context.Background(), "0", "", 10000)
	if err != nil || len(first.Messages) != 2 {
		t.Fatal(first, err)
	}
	before := lists
	same, err := s.snapshot(context.Background(), "0", first.Cursor, 10000)
	if err != nil || lists != before || len(same.Messages) != 0 {
		t.Fatalf("unchanged history cost lists=%d before=%d snapshot=%+v err=%v", lists, before, same, err)
	}
	phase = "changed"
	changed, err := s.snapshot(context.Background(), "0", first.Cursor, 10000)
	if err != nil || changed.Cursor != "e3" || len(changed.Messages) != 2 {
		t.Fatal(changed, err)
	}
	if lists-before != 1 || events != 3 || bodies != 0 {
		t.Fatalf("cost lists=%d events=%d bodies=%d", lists-before, events, bodies)
	}
	if changed.Messages[0].Unread || changed.Messages[1].ReceivedAt != 1000 {
		t.Fatal("flags or old-date metadata lost", changed)
	}
}

func TestIncrementalRecoveryAndIncompleteEventChains(t *testing.T) {
	for _, mode := range []string{"refresh", "labels", "expiry", "more-loop", "unknown-more", "missing-more", "bad-filter", "move", "delete", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			lists := 0
			fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				out := map[string]any{"Code": 1000, "More": 0}
				switch r.URL.Path {
				case "/events/latest":
					out["EventID"] = "fresh"
				case "/events/saved":
					out["EventID"] = "next"
					switch mode {
					case "refresh":
						out["Refresh"] = 1
					case "labels":
						out["Labels"] = []any{map[string]any{"ID": "rule", "Action": 2}}
					case "expiry":
						out["Code"] = 18001
						out["Error"] = "expired fixture"
					case "more-loop":
						out["EventID"] = "saved"
						out["More"] = 1
					case "missing-more":
						delete(out, "More")
					case "unknown-more":
						out["More"] = 2
					case "delete":
						out["Messages"] = []any{map[string]any{"ID": "old", "Action": 0}}
					default:
						out["Messages"] = []any{map[string]any{"ID": "old", "Action": 3, "Message": map[string]any{"Unread": 0}}}
					}
				case "/messages":
					lists++
					id := "old"
					label := "0"
					if mode == "bad-filter" {
						id = "unrequested"
					}
					if mode == "move" {
						label = "6"
					}
					out["Messages"] = []*pm.Message{{ID: id, Type: pm.MessageInbox, Time: 1, LabelIDs: []string{label}}}
					out["Total"] = 1
				default:
					t.Error("unexpected path", r.URL.Path)
					w.WriteHeader(500)
					return
				}
				json.NewEncoder(w).Encode(out)
			}))
			defer fixture.Close()
			s := &mailSession{api: &pm.Client{RootURL: fixture.URL, HTTPClient: fixture.Client()}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancel" {
				cancel()
			}
			got, err := s.snapshot(ctx, "0", "saved", 10000)
			switch mode {
			case "refresh", "labels", "expiry":
				if err != nil || got.Incremental || got.Cursor != "fresh" || len(got.Messages) != 1 || lists != 1 {
					t.Fatal("unsafe full recovery", got, err, lists)
				}
			case "more-loop", "unknown-more", "missing-more", "bad-filter", "cancel":
				if err == nil {
					t.Fatal("incomplete/invalid chain accepted", got)
				}
			case "move", "delete":
				if err != nil || !got.Incremental || len(got.Messages) != 0 || len(got.Removed) != 1 || got.Removed[0] != "old" {
					t.Fatal("exact removal lost", got, err)
				}
			}
		})
	}
}
