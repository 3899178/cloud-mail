package protonmail

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMessageActionsConfirmEveryNestedResult(t *testing.T) {
	reject := true
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := map[string]any{"Code": 1000}
		if reject {
			result = map[string]any{"Code": 2001, "Error": "fixture-denied"}
		}
		json.NewEncoder(w).Encode(map[string]any{"Code": 1000, "Responses": []any{map[string]any{"ID": "stable", "Response": result}}})
	}))
	defer fixture.Close()
	client := &Client{RootURL: fixture.URL, HTTPClient: fixture.Client()}
	operations := []func() error{func() error { return client.MarkMessagesRead([]string{"stable"}) }, func() error { return client.MarkMessagesUnread([]string{"stable"}) }, func() error { return client.LabelMessages(LabelTrash, []string{"stable"}) }, func() error { return client.UnlabelMessages(LabelInbox, []string{"stable"}) }}
	for _, operation := range operations {
		if err := operation(); err == nil {
			t.Fatal("nested provider rejection reported as success")
		}
	}
	reject = false
	for _, operation := range operations {
		if err := operation(); err != nil {
			t.Fatal(err)
		}
	}
}
