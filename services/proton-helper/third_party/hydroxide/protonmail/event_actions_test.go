package protonmail

import (
	"encoding/json"
	"testing"
)

func TestEventMessageActionMustBePresentNonNullKnownEnum(t *testing.T) {
	for _, action := range []string{"", `,"Action":null`, `,"Action":-1`, `,"Action":4`, `,"Action":"0"`, `,"Action":false`, `,"Action":0.5`} {
		t.Run(action, func(t *testing.T) {
			var event EventMessage
			if err := json.Unmarshal([]byte(`{"ID":"admitted"`+action+`}`), &event); err == nil {
				t.Fatal("incomplete or invalid action accepted", event)
			}
		})
	}
	for _, action := range []EventAction{EventDelete, EventCreate, EventUpdate, EventUpdateFlags} {
		data, _ := json.Marshal(map[string]any{"ID": "admitted", "Action": action, "Message": map[string]any{"ID": "admitted", "Unread": 0}})
		var event EventMessage
		if err := json.Unmarshal(data, &event); err != nil || event.Action != action || event.ID != "admitted" {
			t.Fatal("explicit valid action rejected", action, event, err)
		}
	}
}
