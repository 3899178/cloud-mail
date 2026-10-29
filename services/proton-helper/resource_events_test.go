package main

import (
	"context"
	"encoding/json"
	"fmt"
	pm "github.com/emersion/hydroxide/protonmail"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Exercise the exact resource-provider event constructor through pinned JSON
// decoding and the production snapshot, without a Docker/private Unix claim.
func TestResourceProviderEventSnapshots(t *testing.T) {
	for phase := int64(1); phase <= 5; phase++ {
		t.Run(fmt.Sprint(phase), func(t *testing.T) {
			requests := 0
			message := func(id string) *pm.Message {
				label := pm.LabelInbox
				if phase == 3 {
					label = "rule"
				}
				unread := 0
				if phase == 1 {
					unread = 1
				}
				return &pm.Message{ID: id, Time: 1, Type: pm.MessageInbox, Unread: unread, LabelIDs: []string{label}}
			}
			fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				out := map[string]any{"Code": 1000}
				switch r.URL.Path {
				case "/events/saved":
					out["EventID"] = "next"
					out["More"] = 0
					out["Messages"] = []any{resourceMessageEvent(phase, message)}
				case "/messages":
					ids := r.URL.Query()["IDs[]"]
					id := "new"
					if phase == 5 {
						id = "large"
					}
					if len(ids) != 1 || ids[0] != id {
						t.Error("resource delta must request exact changed ID", ids)
					}
					requests++
					out["Total"] = 1
					out["Messages"] = []*pm.Message{message(id)}
				default:
					t.Error("unexpected provider request", r.URL.Path)
					w.WriteHeader(500)
					return
				}
				json.NewEncoder(w).Encode(out)
			}))
			defer fixture.Close()
			session := &mailSession{api: &pm.Client{RootURL: fixture.URL, HTTPClient: fixture.Client()}}
			for _, label := range []string{pm.LabelInbox, pm.LabelArchive, "rule"} {
				got, err := session.snapshot(context.Background(), label, "saved", 0)
				if err != nil {
					t.Fatalf("resource phase%d snapshot: %v (metadataRequests=%d)", phase, err, requests)
				}
				if !got.Incremental || got.Cursor != "next" || len(got.Removed) != 1 {
					t.Fatal("incomplete delta", got)
				}
				want := 0
				if phase != 4 && ((phase == 3 && label == "rule") || (phase != 3 && label == pm.LabelInbox)) {
					want = 1
				}
				if len(got.Messages) != want {
					t.Fatal("incorrect label membership", label, got)
				}
				if want == 1 && (got.Messages[0].ReceivedAt != 1000 || got.Messages[0].Unread != (phase == 1)) {
					t.Fatal("old Date/flag lost", got)
				}
			}
			wantRequests := 3
			if phase == 4 {
				wantRequests = 0
			}
			if requests != wantRequests {
				t.Fatal("metadata request count", requests, wantRequests)
			}
		})
	}
}
