package main

// Only compiled into the CI fixture binary, never the production helper. The
// exact production binary keeps its HTTPS host restriction and uses normal
// refresh/unlock/events/PGP/MIME paths against this isolated TLS upstream.
import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"github.com/ProtonMail/go-crypto/openpgp"
	pm "github.com/emersion/hydroxide/protonmail"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureZeros struct{}

func (fixtureZeros) Read(p []byte) (int, error) { clear(p); return len(p), nil }
func resourceMessageEvent(phase int64, message func(string) *pm.Message) map[string]any {
	id := "new"
	action := pm.EventCreate
	if phase == 2 || phase == 3 {
		action = pm.EventUpdate
	}
	if phase == 4 {
		action = pm.EventDelete
	}
	if phase == 5 {
		id = "large"
	}
	change := map[string]any{"ID": id, "Action": action}
	// The pinned event decoder requires Message for create/update, even though
	// snapshots independently fetch authoritative metadata by the exact IDs.
	if action != pm.EventDelete {
		change["Message"] = message(id)
	}
	return change
}
func TestResourceProviderChild(t *testing.T) {
	if os.Getenv("CLOUD_MAIL_RESOURCE_PROVIDER") != "1" {
		return
	}
	dir := os.Getenv("CLOUD_MAIL_RESOURCE_DIR")
	if dir == "" {
		t.Fatal("private fixture output required")
	}
	entity, key := keyFixture(t)
	attachment := &pm.Attachment{ID: "large", Name: "largest.bin", MIMEType: "application/octet-stream", Size: 25 * 1024 * 1024}
	if _, err := attachment.GenerateKey([]*openpgp.Entity{entity}); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(dir, "fixture-ciphertext"))
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := attachment.Encrypt(file, entity)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.CopyN(encrypted, fixtureZeros{}, attachmentLimit); err != nil {
		t.Fatal(err)
	}
	if err = encrypted.Close(); err != nil {
		t.Fatal(err)
	}
	file.Close()
	tlsKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "mail.proton.me"}, DNSNames: []string{"mail.proton.me"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &tlsKey.PublicKey, tlsKey)
	if err != nil {
		t.Fatal(err)
	}
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDer, _ := x509.MarshalECPrivateKey(tlsKey)
	pair, err := tls.X509KeyPair(ca, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDer}))
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "proton-ca.pem"), ca, 0644)
	var phase, requests, metadata, egress, throttles atomic.Int64
	current := func() string { return fmt.Sprint("e", phase.Load()) }
	message := func(id string) *pm.Message {
		m := &pm.Message{ID: id, Time: 1, Type: pm.MessageInbox, Unread: 0, LabelIDs: []string{pm.LabelArchive}, ExternalID: id + "@fixture.test", MIMEType: "text/plain", Body: "Original body"}
		if id == "new" {
			m.LabelIDs = []string{pm.LabelInbox}
			if phase.Load() == 1 {
				m.Unread = 1
			}
			if phase.Load() == 3 {
				m.LabelIDs = []string{"rule"}
			}
		}
		if id == "large" {
			m.LabelIDs = []string{pm.LabelInbox}
			m.Attachments = []*pm.Attachment{attachment}
			w, e := m.Encrypt([]*openpgp.Entity{entity}, entity)
			if e != nil {
				panic(e)
			}
			w.Write([]byte("encrypted original body"))
			w.Close()
		}
		return m
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/control/") {
			switch strings.TrimPrefix(r.URL.Path, "/control/") {
			case "burst":
				phase.Store(1)
			case "read":
				phase.Store(2)
			case "move":
				phase.Store(3)
			case "delete":
				phase.Store(4)
			case "large":
				phase.Store(5)
			case "throttle":
				phase.Store(6)
			}
			json.NewEncoder(w).Encode(map[string]any{"requests": requests.Load(), "metadataRows": metadata.Load(), "egressBytes": egress.Load(), "http429": throttles.Load()})
			return
		}
		requests.Add(1)
		out := map[string]any{"Code": 1000}
		path := strings.TrimPrefix(r.URL.Path, "/api")
		switch {
		case path == "/auth/refresh":
			out["UID"] = "fixture"
			out["AccessToken"] = "fixture"
			out["RefreshToken"] = "fixture"
			out["ExpiresIn"] = 3600
		case path == "/users":
			out["User"] = &pm.User{ID: "fixture", Keys: []*pm.PrivateKey{key}}
		case path == "/addresses":
			out["Addresses"] = []*pm.Address{{ID: "fixture", Email: "a49@fixture.test", Status: pm.AddressEnabled, Send: pm.AddressSendPrimary, Keys: []*pm.PrivateKey{key}}}
		case path == "/labels":
			out["Labels"] = []*pm.Label{{ID: "rule", Type: pm.LabelMessage, Exclusive: 1}}
		case path == "/events/latest":
			out["EventID"] = current()
			out["More"] = 0
		case strings.HasPrefix(path, "/events/"):
			if phase.Load() == 6 {
				throttles.Add(1)
				w.Header().Set("Retry-After", "2")
				w.WriteHeader(429)
				w.Write([]byte(`{"Code":429,"Error":"synthetic throttle"}`))
				return
			}
			out["EventID"] = current()
			out["More"] = 0
			cursor := strings.TrimPrefix(path, "/events/")
			if cursor != current() {
				out["Messages"] = []map[string]any{resourceMessageEvent(phase.Load(), message)}
			}
		case path == "/messages":
			rows := []*pm.Message{}
			ids := r.URL.Query()["IDs[]"]
			if len(ids) > 0 {
				for _, id := range ids {
					rows = append(rows, message(id))
				}
				out["Total"] = len(rows)
			} else {
				label := r.URL.Query().Get("Label")
				if label == pm.LabelArchive {
					page, _ := strconv.Atoi(r.URL.Query().Get("Page"))
					for i := page * 100; i < (page+1)*100 && i < 10000; i++ {
						rows = append(rows, message(fmt.Sprint("h", i)))
					}
					out["Total"] = 10000
				} else {
					out["Total"] = 0
				}
			}
			metadata.Add(int64(len(rows)))
			out["Messages"] = rows
		case strings.HasPrefix(path, "/messages/"):
			out["Message"] = message(strings.TrimPrefix(path, "/messages/"))
		case path == "/attachments/large":
			f, e := os.Open(filepath.Join(dir, "fixture-ciphertext"))
			if e != nil {
				w.WriteHeader(500)
				return
			}
			defer f.Close()
			n, _ := io.Copy(w, f)
			egress.Add(n)
			return
		default:
			w.WriteHeader(500)
			return
		}
		var buf bytes.Buffer
		json.NewEncoder(&buf).Encode(out)
		egress.Add(int64(buf.Len()))
		w.Header().Set("Content-Type", "application/json")
		w.Write(buf.Bytes())
	})
	server := &http.Server{Addr: "0.0.0.0:443", Handler: handler, TLSConfig: &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}}
	fmt.Println("RESOURCE_PROTON_PROVIDER_READY")
	t.Fatal(server.ListenAndServeTLS("", ""))
}
