package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	pm "github.com/emersion/hydroxide/protonmail"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"net/textproto"
	"strings"
	"sync"
	"time"
)

const rawLimit = 36 * 1024 * 1024
const attachmentLimit = 25 * 1024 * 1024

type mailAPI interface {
	GetEvent(string) (*pm.Event, error)
	ListMessages(*pm.MessageFilter) (int, []*pm.Message, error)
	ListLabels() ([]*pm.Label, error)
	GetMessage(string) (*pm.Message, error)
	GetAttachment(string) (io.ReadCloser, error)
	MarkMessagesRead([]string) error
	MarkMessagesUnread([]string) error
	LabelMessages(string, []string) error
	UnlabelMessages(string, []string) error
}
type mailSession struct {
	api            mailAPI
	client         *pm.Client
	keys           openpgp.EntityList
	owner, account string
	expires        int64
	busy           sync.Mutex
}
type record struct {
	ID          string `json:"id"`
	StableID    string `json:"stableId"`
	ReceivedAt  int64  `json:"receivedAt"`
	Unread      bool   `json:"unread"`
	MessageID   string `json:"messageId,omitempty"`
	Fingerprint string `json:"fingerprint"`
}
type snapshot struct {
	UIDValidity string   `json:"uidValidity"`
	Cursor      string   `json:"cursor"`
	Messages    []record `json:"messages"`
}
type folder struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

var errCapacity = errors.New("CAPACITY_EXCEEDED")
var errAuth = errors.New("AUTH_REQUIRED")
var errUnauthorized = errors.New("UNAUTHORIZED")
var errSync = errors.New("SYNC_FAILED")

func safeCode(err error) string {
	if errors.Is(err, errCapacity) {
		return "CAPACITY_EXCEEDED"
	}
	if errors.Is(err, errUnauthorized) {
		return "UNAUTHORIZED"
	}
	if errors.Is(err, errAuth) {
		return "AUTH_REQUIRED"
	}
	var hv *pm.HumanVerificationRequiredError
	if errors.As(err, &hv) {
		return "AUTH_REQUIRED"
	}
	var api *pm.APIError
	if errors.As(err, &api) && (api.Code == 10013 || api.Code == 8002 || api.Code == 8005) {
		return "AUTH_REQUIRED"
	}
	return "SYNC_FAILED"
}
func normalMessage(m *pm.Message) bool {
	if m == nil || m.Type != pm.MessageInbox {
		return false
	}
	for _, l := range m.LabelIDs {
		switch l {
		case pm.LabelTrash, pm.LabelSpam, pm.LabelAllDraft, pm.LabelAllSent, pm.LabelSent, pm.LabelDraft:
			return false
		}
	}
	return true
}
func (s *mailSession) folders() ([]folder, error) {
	labels, err := s.api.ListLabels()
	if err != nil {
		return nil, err
	}
	out := []folder{{pm.LabelInbox, "inbox"}, {pm.LabelArchive, "archive"}}
	seen := map[string]bool{pm.LabelInbox: true, pm.LabelArchive: true}
	for _, l := range labels {
		if l.Type == pm.LabelMessage && l.Exclusive == 1 && !seen[l.ID] && len(l.ID) > 2 {
			out = append(out, folder{l.ID, "rule"})
			seen[l.ID] = true
		}
	}
	if len(out) > 200 {
		return nil, errCapacity
	}
	return out, nil
}
func (s *mailSession) snapshot(ctx context.Context, label, cursor string, boundary int64) (snapshot, error) {
	result := snapshot{UIDValidity: "proton-message-id-v1", Messages: []record{}}
	// Event expiry/reset is recovered by a complete bounded inventory, never by an IMAP UID.
	if cursor != "" {
		if _, err := s.api.GetEvent(cursor); err != nil {
			var api *pm.APIError
			if !errors.As(err, &api) {
				return result, err
			}
		}
	}
	event, err := s.api.GetEvent("")
	if err != nil {
		return result, err
	}
	if event == nil || event.ID == "" || len(event.ID) > 8192 {
		return result, errSync
	}
	result.Cursor = event.ID
	seen := map[string]bool{}
	metadata := 0
	totalSeen := 0
	for page := 0; page < 201; page++ {
		if err = ctx.Err(); err != nil {
			return result, err
		}
		total, messages, e := s.api.ListMessages(&pm.MessageFilter{Label: label, Page: page, PageSize: 100, Sort: "ID", Asc: true})
		if e != nil {
			return result, e
		}
		if total > 20000 || total < 0 {
			return result, errCapacity
		}
		for _, m := range messages {
			totalSeen++
			if m == nil || m.ID == "" || len(m.ID) > 512 || seen[m.ID] {
				return result, errSync
			}
			seen[m.ID] = true
			at := int64(m.Time) * 1000
			if at < 0 {
				return result, errSync
			}
			if !normalMessage(m) || at < boundary {
				continue
			}
			r := record{ID: m.ID, StableID: m.ID, ReceivedAt: at, Unread: m.Unread != 0, MessageID: messageID(m.ExternalID), Fingerprint: m.ID}
			metadata += len(m.ID)*3 + len(m.ExternalID) + 128
			if metadata > 8*1024*1024 {
				return result, errCapacity
			}
			result.Messages = append(result.Messages, r)
		}
		if totalSeen == total {
			return result, nil
		}
		if len(messages) == 0 || totalSeen > total {
			return result, errSync
		}
	}
	return result, errCapacity
}
func (s *mailSession) flags(id string, unread bool) error {
	if unread {
		return s.api.MarkMessagesUnread([]string{id})
	}
	return s.api.MarkMessagesRead([]string{id})
}
func (s *mailSession) trash(id string) error {
	m, err := s.api.GetMessage(id)
	if err != nil {
		return err
	}
	if err = s.api.LabelMessages(pm.LabelTrash, []string{id}); err != nil {
		return err
	}
	for _, label := range m.LabelIDs {
		if label == pm.LabelInbox || label == pm.LabelArchive || len(label) > 2 {
			if err = s.api.UnlabelMessages(label, []string{id}); err != nil {
				return err
			}
		}
	}
	return nil
}

type boundedWriter struct {
	w   io.Writer
	n   int64
	max int64
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if w.n+int64(len(p)) > w.max {
		return 0, errCapacity
	}
	total := 0
	for len(p) > 0 {
		length := len(p)
		if length > 65536 {
			length = 65536
		}
		n, err := w.w.Write(p[:length])
		total += n
		w.n += int64(n)
		if err != nil {
			return total, err
		}
		if n != length {
			return total, io.ErrShortWrite
		}
		p = p[n:]
	}
	return total, nil
}
func copyBounded(ctx context.Context, w io.Writer, r io.Reader, max int64) error {
	var used int64
	buf := make([]byte, 65536)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, e := r.Read(buf)
		used += int64(n)
		if used > max {
			return errCapacity
		}
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return err
			}
		}
		if e == io.EOF {
			return nil
		}
		if e != nil {
			return e
		}
	}
}
func clean(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r", ""), "\n", "")
}
func messageID(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "<") && strings.HasSuffix(value, ">") {
		value = value[1 : len(value)-1]
	}
	if value == "" || len(value) > 998 || strings.ContainsAny(value, "<> \t\r\n\x00") {
		return ""
	}
	return "<" + value + ">"
}
func address(a *pm.MessageAddress) string {
	if a == nil {
		return ""
	}
	return (&mail.Address{Name: clean(a.Name), Address: clean(a.Address)}).String()
}
func addresses(list []*pm.MessageAddress) string {
	out := []string{}
	for _, a := range list {
		out = append(out, address(a))
	}
	return strings.Join(out, ", ")
}
func readPGP(input io.Reader, keys openpgp.EntityList, max int64) (io.Reader, error) {
	details, err := openpgp.ReadMessage(input, keys, nil, &packet.Config{MaxDecompressedMessageSize: &max})
	if err != nil {
		return nil, err
	}
	return &hardLimitReader{reader: details.UnverifiedBody, remaining: max}, nil
}

type hardLimitReader struct {
	reader    io.Reader
	remaining int64
}

func (r *hardLimitReader) Read(p []byte) (int, error) {
	if int64(len(p)) > r.remaining+1 {
		p = p[:r.remaining+1]
	}
	n, err := r.reader.Read(p)
	if int64(n) > r.remaining {
		return 0, errCapacity
	}
	r.remaining -= int64(n)
	return n, err
}
func (s *mailSession) mime(ctx context.Context, id string, dst io.Writer) error {
	msg, err := s.api.GetMessage(id)
	if err != nil {
		return err
	}
	if len(msg.Attachments) > 20 {
		return errCapacity
	}
	output := &boundedWriter{w: dst, max: rawLimit}
	multi := multipart.NewWriter(output)
	// Proton stores a decrypted body and attachment objects. This is reconstructed MIME.
	headers := []string{"MIME-Version: 1.0", "Subject: " + mime.QEncoding.Encode("utf-8", clean(msg.Subject)), "From: " + address(msg.Sender), "To: " + addresses(msg.ToList), "Cc: " + addresses(msg.CCList), "Date: " + msg.Time.Time().Format(time.RFC1123Z), "Content-Type: multipart/mixed; boundary=" + multi.Boundary()}
	if id := messageID(msg.ExternalID); id != "" {
		headers = append(headers, "Message-ID: "+id)
	}
	if _, err = io.WriteString(output, strings.Join(headers, "\r\n")+"\r\n\r\n"); err != nil {
		return err
	}
	bodyType := msg.MIMEType
	if bodyType == "" {
		bodyType = "text/html"
	}
	if _, _, err = mime.ParseMediaType(bodyType); err != nil {
		return errSync
	}
	part, err := multi.CreatePart(textproto.MIMEHeader{"Content-Type": {bodyType + "; charset=utf-8"}, "Content-Transfer-Encoding": {"8bit"}})
	if err != nil {
		return err
	}
	var body io.Reader = strings.NewReader(msg.Body)
	if msg.IsEncrypted != pm.MessageUnencrypted {
		block, e := armor.Decode(body)
		if e != nil {
			return e
		}
		body, err = readPGP(block.Body, s.keys, rawLimit)
		if err != nil {
			return err
		}
	}
	if err = copyBounded(ctx, part, body, rawLimit); err != nil {
		return err
	}
	for _, a := range msg.Attachments {
		if a.Size < 0 || a.Size > attachmentLimit {
			return errCapacity
		}
		raw, err := s.api.GetAttachment(a.ID)
		if err != nil {
			return err
		}
		e := func() error {
			defer raw.Close()
			var data io.Reader = raw
			if a.KeyPackets != "" {
				data, err = readPGP(io.MultiReader(base64.NewDecoder(base64.StdEncoding, strings.NewReader(a.KeyPackets)), raw), s.keys, attachmentLimit)
				if err != nil {
					return err
				}
			}
			typ := a.MIMEType
			if _, _, err = mime.ParseMediaType(typ); err != nil {
				typ = "application/octet-stream"
			}
			header := textproto.MIMEHeader{"Content-Type": {typ}, "Content-Disposition": {mime.FormatMediaType("attachment", map[string]string{"filename": clean(a.Name)})}, "Content-Transfer-Encoding": {"base64"}}
			if a.ContentID != "" {
				header.Set("Content-ID", clean(a.ContentID))
			}
			part, err := multi.CreatePart(header)
			if err != nil {
				return err
			}
			encoder := base64.NewEncoder(base64.StdEncoding, part)
			if err = copyBounded(ctx, encoder, data, attachmentLimit); err != nil {
				return err
			}
			return encoder.Close()
		}()
		if e != nil {
			return e
		}
	}
	return multi.Close()
}
func required(value string, max int) error {
	if value == "" || len(value) > max || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("INVALID_INPUT")
	}
	return nil
}
