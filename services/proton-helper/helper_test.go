package main

import (
	"bytes"
	"context"
	"errors"
	pm "github.com/emersion/hydroxide/protonmail"
	"io"
	"strings"
	"testing"
)

type fixtureAPI struct {
	cursor        string
	reset         bool
	messages      []*pm.Message
	read, trashed string
	sourceErr     bool
}

func (f *fixtureAPI) GetEvent(cursor string) (*pm.Event, error) {
	if f.sourceErr {
		return nil, errors.New("SECRET provider error")
	}
	more := 0
	return &pm.Event{ID: f.cursor, More: &more, Refresh: map[bool]pm.EventRefresh{true: pm.EventRefreshMail}[f.reset]}, nil
}
func (f *fixtureAPI) ListMessages(filter *pm.MessageFilter) (int, []*pm.Message, error) {
	if f.sourceErr {
		return 0, nil, errors.New("SECRET")
	}
	if filter.Page > 0 {
		return len(f.messages), nil, nil
	}
	return len(f.messages), f.messages, nil
}
func (f *fixtureAPI) ListLabels() ([]*pm.Label, error) {
	return []*pm.Label{{ID: "rule", Type: pm.LabelMessage, Exclusive: 1}}, nil
}
func (f *fixtureAPI) GetMessage(id string) (*pm.Message, error) {
	for _, m := range f.messages {
		if m.ID == id {
			return m, nil
		}
	}
	return nil, errors.New("SECRET missing")
}
func (f *fixtureAPI) GetAttachment(id string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader([]byte{0, 1, 255, 13, 10})), nil
}
func (f *fixtureAPI) MarkMessagesRead(ids []string) error   { f.read = ids[0]; return nil }
func (f *fixtureAPI) MarkMessagesUnread(ids []string) error { f.read = "unread:" + ids[0]; return nil }
func (f *fixtureAPI) LabelMessages(label string, ids []string) error {
	f.trashed = label + ":" + ids[0]
	return nil
}
func (f *fixtureAPI) UnlabelMessages(label string, ids []string) error { return nil }
func TestSnapshotRecoveryStableBoundaryAndFlags(t *testing.T) {
	f := &fixtureAPI{cursor: "real-event-token", reset: true, messages: []*pm.Message{{ID: "old", Time: 1, Type: pm.MessageInbox}, {ID: "stable-message", Time: 20, Type: pm.MessageInbox, ExternalID: "external@example.test"}, {ID: "sent", Time: 30, Type: pm.MessageSent}}}
	s := &mailSession{api: f}
	got, err := s.snapshot(context.Background(), "0", "expired-event", 10000)
	if err != nil {
		t.Fatal(err)
	}
	if got.Cursor != "real-event-token" || len(got.Messages) != 2 || got.Messages[0].ID != "old" || got.Messages[1].ID != "stable-message" || got.Messages[1].StableID != "stable-message" {
		t.Fatalf("unsafe recovery: %+v", got)
	}
	if got.Messages[1].MessageID != "<external@example.test>" {
		t.Fatal("reply identity lost", got.Messages[1].MessageID)
	}
	f.reset = false
	again, err := s.snapshot(context.Background(), "0", got.Cursor, 10000)
	if err != nil || !again.Incremental || len(again.Messages) != 0 || again.Cursor != got.Cursor {
		t.Fatal("unstable resync")
	}
	if err = s.flags("stable-message", true); err != nil || f.read != "unread:stable-message" {
		t.Fatal(err)
	}
	if err = s.trash("stable-message"); err != nil || f.trashed != "3:stable-message" {
		t.Fatal(err)
	}
	f.cursor = ""
	if _, err = s.snapshot(context.Background(), "0", "", 0); err == nil {
		t.Fatal("empty cursor accepted")
	}
}
func TestSnapshotsReturnPrecutoffMetadataBeforeAndAfterBaseline(t *testing.T) {
	f := &fixtureAPI{cursor: "first-real-event", messages: []*pm.Message{{ID: "history", Time: 1, Type: pm.MessageInbox}}}
	s := &mailSession{api: f}
	first, err := s.snapshot(context.Background(), "0", "", 10000)
	if err != nil || len(first.Messages) != 1 || first.Messages[0].ID != "history" {
		t.Fatalf("incomplete initial metadata: %+v %v", first, err)
	}
	f.cursor = "reset-real-event"
	f.reset = true
	f.messages = append(f.messages, &pm.Message{ID: "new-stable-old-date", Time: 2, Type: pm.MessageInbox})
	second, err := s.snapshot(context.Background(), "0", first.Cursor, 10000)
	if err != nil || len(second.Messages) != 2 || second.Messages[1].StableID != "new-stable-old-date" || second.Cursor != f.cursor {
		t.Fatalf("lost post-baseline metadata: %+v %v", second, err)
	}
}
func TestMIMEStreamsOriginalAttachmentBytes(t *testing.T) {
	f := &fixtureAPI{messages: []*pm.Message{{ID: "stable", Subject: "hello", Sender: &pm.MessageAddress{Address: "a@example.test"}, Time: 20, Body: "hello body", MIMEType: "text/plain", Attachments: []*pm.Attachment{{ID: "a", Name: "original.bin", MIMEType: "application/octet-stream", Size: 5}}}}}
	s := &mailSession{api: f}
	var output bytes.Buffer
	if err := s.mime(context.Background(), "stable", &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "AAH/DQo=") || !strings.Contains(output.String(), "original.bin") || !strings.Contains(output.String(), "hello body") {
		t.Fatal(output.String())
	}
}
func TestSafeErrorNeverLeaksProviderDetails(t *testing.T) {
	if got := safeCode(errors.New("SECRET token")); got != "SYNC_FAILED" {
		t.Fatal(got)
	}
}
func TestChallengeExpiryOwnerBindingAndSingleUse(t *testing.T) {
	h := newHelper()
	h.now = func() int64 { return 1000 }
	token, err := h.addChallenge("one", "account", &pendingAuth{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.takeChallenge("two", "account", token); err == nil {
		t.Fatal("cross owner")
	}
	if _, err = h.takeChallenge("one", "account", token); err != nil {
		t.Fatal(err)
	}
	if _, err = h.takeChallenge("one", "account", token); err == nil {
		t.Fatal("replay")
	}
	token, _ = h.addChallenge("one", "account", &pendingAuth{})
	h.now = func() int64 { return 301001 }
	if _, err = h.takeChallenge("one", "account", token); err == nil {
		t.Fatal("expired")
	}
}
