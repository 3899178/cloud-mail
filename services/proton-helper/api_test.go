package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	pm "github.com/emersion/hydroxide/protonmail"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type noCloseWriter struct{ io.Writer }

func (w noCloseWriter) Close() error { return nil }
func keyFixture(t *testing.T) (*openpgp.Entity, *pm.PrivateKey) {
	t.Helper()
	entity, err := openpgp.NewEntity("Fixture", "", "user@proton.me", &packet.Config{Algorithm: packet.PubKeyAlgoEdDSA})
	if err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	armored, err := armor.Encode(&buffer, openpgp.PrivateKeyType, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = entity.SerializePrivate(armored, nil); err != nil {
		t.Fatal(err)
	}
	armored.Close()
	return entity, &pm.PrivateKey{ID: "key", Active: 1, Primary: 1, PrivateKey: buffer.String()}
}
func TestPinnedAPIRefreshUnlockAndEncryptedSendAttachment(t *testing.T) {
	entity, key := keyFixture(t)
	original := []byte{0, 1, 255, 13, 10}
	var uploaded, packets []byte
	submissions := 0
	refreshes := 0
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		response := map[string]any{"Code": 1000}
		switch {
		case r.URL.Path == "/auth/refresh":
			refreshes++
			response["UID"] = "uid"
			response["AccessToken"] = "fresh-access"
			response["RefreshToken"] = "rotated-refresh"
			response["ExpiresIn"] = 3600
		case r.URL.Path == "/users":
			response["User"] = &pm.User{ID: "user", Keys: []*pm.PrivateKey{key}}
		case r.URL.Path == "/addresses":
			response["Addresses"] = []*pm.Address{{ID: "address", Email: "user@proton.me", Status: pm.AddressEnabled, Send: pm.AddressSendPrimary, Keys: []*pm.PrivateKey{key}}}
		case r.URL.Path == "/messages" && r.Method == "POST":
			response["Message"] = &pm.Message{ID: "draft"}
		case r.URL.Path == "/attachments":
			multipart, e := r.MultipartReader()
			if e != nil {
				t.Error(e)
				w.WriteHeader(500)
				return
			}
			for {
				part, e := multipart.NextPart()
				if e == io.EOF {
					break
				}
				if e != nil {
					t.Error(e)
					break
				}
				data, _ := io.ReadAll(io.LimitReader(part, 4096))
				if part.FormName() == "DataPacket" {
					uploaded = data
				}
				if part.FormName() == "KeyPackets" {
					packets = data
				}
			}
			response["Attachment"] = &pm.Attachment{ID: "uploaded"}
		case r.URL.Path == "/messages/draft" && r.Method == "PUT":
			response["Message"] = &pm.Message{ID: "draft"}
		case r.URL.Path == "/keys":
			response["RecipientType"] = pm.RecipientExternal
			response["Keys"] = []*pm.PublicKey{}
		case r.URL.Path == "/messages/draft" && r.Method == "POST":
			submissions++
			var outgoing pm.OutgoingMessage
			if e := json.NewDecoder(r.Body).Decode(&outgoing); e != nil {
				t.Error(e)
			}
			if len(outgoing.Packages) != 1 || outgoing.Packages[0].AttachmentKeys["uploaded"] == nil {
				t.Error("attachment package missing")
			}
			response["Sent"] = &pm.Message{ID: "sent"}
		default:
			t.Error("unexpected API operation", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		json.NewEncoder(w).Encode(response)
	}))
	defer fixture.Close()
	h := newHelper()
	h.newClient = func(ctx context.Context) *pm.Client {
		return &pm.Client{RootURL: fixture.URL, HTTPClient: fixture.Client()}
	}
	opened, err := h.open(context.Background(), command{Owner: "one", Account: "account", Material: &material{Auth: &pm.Auth{UID: "old", RefreshToken: "old-refresh", PasswordMode: pm.PasswordSingle}, MailboxPassword: "fixture-password"}})
	if err != nil {
		t.Fatal(err)
	}
	if refreshes != 1 || opened["material"].(*material).Auth.RefreshToken != "rotated-refresh" {
		t.Fatal("refresh not returned for Node vault")
	}
	s, err := h.session(command{Owner: "one", Account: "account", Session: opened["session"].(string)})
	if err != nil {
		t.Fatal(err)
	}
	input := "From: user@proton.me\r\nTo: recipient@example.test\r\nSubject: fixture\r\nMessage-ID: <fixture@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=original.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAH/DQo=\r\n--x--\r\n"
	if err = s.send(context.Background(), strings.NewReader(input), []string{"recipient@example.test"}); err != nil {
		t.Fatal(err)
	}
	attachment := &pm.Attachment{KeyPackets: base64.StdEncoding.EncodeToString(packets)}
	decrypted, err := attachment.Read(bytes.NewReader(uploaded), openpgp.EntityList{entity}, nil)
	if err != nil {
		t.Fatal(err)
	}
	received, err := io.ReadAll(decrypted.UnverifiedBody)
	if err != nil || !bytes.Equal(received, original) {
		t.Fatal("attachment bytes changed", received, err)
	}
	if submissions != 1 {
		t.Fatal("submission count", submissions)
	}
}
func TestChallengeCapacityAndSourceErrorsDoNotAdvance(t *testing.T) {
	h := newHelper()
	for i := 0; i < 16; i++ {
		if _, err := h.addChallenge("owner", string(rune('a'+i)), &pendingAuth{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.addChallenge("owner", "overflow", &pendingAuth{}); err != errCapacity {
		t.Fatal(err)
	}
	f := &fixtureAPI{sourceErr: true}
	s := &mailSession{api: f}
	result, err := s.snapshot(context.Background(), "0", "last-good-event", 10000)
	if err == nil || result.Cursor != "" || len(result.Messages) != 0 {
		t.Fatal("source error advanced checkpoint")
	}
}
func TestDecryptedPGPExpansionBound(t *testing.T) {
	entity, _ := keyFixture(t)
	var ciphertext bytes.Buffer
	max := int64(1024)
	compressed, err := packet.SerializeCompressed(noCloseWriter{&ciphertext}, packet.CompressionZLIB, nil)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := packet.SerializeLiteral(compressed, true, "fixture", 0)
	if err != nil {
		t.Fatal(err)
	}
	writer.Write(bytes.Repeat([]byte("x"), 4096))
	writer.Close()
	reader, err := readPGP(bytes.NewReader(ciphertext.Bytes()), openpgp.EntityList{entity}, max)
	if err == nil {
		_, err = io.Copy(io.Discard, reader)
	}
	if err == nil {
		t.Fatal("decompression limit ignored")
	}
}
func TestOpenCancellationAndMaterialCap(t *testing.T) {
	h := newHelper()
	h.now = func() int64 { return time.Now().UnixMilli() }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.open(ctx, command{Material: &material{Auth: &pm.Auth{RefreshToken: "secret"}}}); err == nil {
		t.Fatal("invalid material accepted")
	}
	body := &limitedBody{ReadCloser: io.NopCloser(strings.NewReader("123456")), remaining: 3}
	buffer := make([]byte, 10)
	n, err := body.Read(buffer)
	if n != 3 || err != nil {
		t.Fatal(n, err)
	}
	if _, err = body.Read(buffer); err != errCapacity {
		t.Fatal("unbounded upstream read")
	}
}
