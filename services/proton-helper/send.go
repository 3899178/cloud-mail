package main

import (
	"bytes"
	"context"
	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	gm "github.com/emersion/go-message/mail"
	pm "github.com/emersion/hydroxide/protonmail"
	"io"
	"net/mail"
	"strings"
)

func pmAddresses(list []*mail.Address) []*pm.MessageAddress {
	out := []*pm.MessageAddress{}
	for _, a := range list {
		out = append(out, &pm.MessageAddress{Address: a.Address, Name: a.Name})
	}
	return out
}
func (s *mailSession) send(ctx context.Context, input io.Reader, recipients []string) error {
	if len(recipients) == 0 || len(recipients) > 60 {
		return errSync
	}
	for _, r := range recipients {
		a, e := mail.ParseAddress(r)
		if e != nil || a.Address != r {
			return errSync
		}
	}
	mr, err := gm.CreateReader(input)
	if err != nil {
		return err
	}
	defer mr.Close()
	from, err := mr.Header.AddressList("From")
	if err != nil || len(from) != 1 {
		return errSync
	}
	addrs, err := s.client.ListAddresses()
	if err != nil {
		return err
	}
	var sender *pm.Address
	var signer *openpgp.Entity
	for _, a := range addrs {
		if strings.EqualFold(a.Email, from[0].Address) && a.Status == pm.AddressEnabled && a.Send != pm.AddressSendDisabled {
			sender = a
			break
		}
	}
	if sender == nil {
		return errAuth
	}
	for _, key := range sender.Keys {
		entity, e := key.Entity()
		if e != nil {
			continue
		}
		for _, private := range s.keys {
			if private.PrimaryKey.KeyId == entity.PrimaryKey.KeyId {
				signer = private
				break
			}
		}
		if signer != nil {
			break
		}
	}
	if signer == nil {
		return errAuth
	}
	to, _ := mr.Header.AddressList("To")
	cc, _ := mr.Header.AddressList("Cc")
	bcc, _ := mr.Header.AddressList("Bcc")
	visible := map[string]bool{}
	for _, a := range append(append(to, cc...), bcc...) {
		visible[a.Address] = true
	}
	for _, r := range recipients {
		if !visible[r] {
			bcc = append(bcc, &mail.Address{Address: r})
		}
	}
	subject, _ := mr.Header.Subject()
	msgID, _ := mr.Header.MessageID()
	var header bytes.Buffer
	fields := mr.Header.Fields()
	for fields.Next() {
		header.WriteString(fields.Key() + ": " + fields.Value() + "\r\n")
	}
	msg := &pm.Message{Subject: subject, ToList: pmAddresses(to), CCList: pmAddresses(cc), BCCList: pmAddresses(bcc), AddressID: sender.ID, ExternalID: msgID, Header: header.String(), Sender: &pm.MessageAddress{Address: sender.Email}}
	encrypt, err := msg.Encrypt([]*openpgp.Entity{signer}, signer)
	if err != nil {
		return err
	}
	if err = encrypt.Close(); err != nil {
		return err
	}
	// No auto retry at any stage. A draft may remain if upload/submission fails.
	msg, err = s.client.CreateDraftMessage(msg, "")
	if err != nil {
		return err
	}
	body := []byte{}
	bodyType := "text/plain"
	keys := map[string]*packet.EncryptedKey{}
	attachments := 0
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		part, e := mr.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		switch h := part.Header.(type) {
		case *gm.InlineHeader:
			typ, _, e := h.ContentType()
			if e != nil {
				return e
			}
			if typ != "text/html" && typ != "text/plain" {
				continue
			}
			if len(body) > 0 && typ != "text/html" {
				continue
			}
			var buffer bytes.Buffer
			if e = copyBounded(ctx, &buffer, part.Body, 4*1024*1024); e != nil {
				return e
			}
			body = buffer.Bytes()
			bodyType = typ
		case *gm.AttachmentHeader:
			attachments++
			if attachments > 20 {
				return errCapacity
			}
			name, e := h.Filename()
			if e != nil {
				return e
			}
			typ, _, _ := h.ContentType()
			a := &pm.Attachment{MessageID: msg.ID, Name: name, MIMEType: typ, ContentID: h.Get("Content-ID")}
			key, e := a.GenerateKey([]*openpgp.Entity{signer})
			if e != nil {
				return e
			}
			pr, pw := io.Pipe()
			done := make(chan error, 1)
			go func() {
				writer, e := a.Encrypt(pw, signer)
				if e == nil {
					e = copyBounded(ctx, writer, part.Body, attachmentLimit)
					if e == nil {
						e = writer.Close()
					}
				}
				pw.CloseWithError(e)
				done <- e
			}()
			created, e := s.client.CreateAttachment(a, pr)
			pr.CloseWithError(e)
			streamErr := <-done
			if e != nil {
				return e
			}
			if streamErr != nil {
				return streamErr
			}
			keys[created.ID] = key
		}
	}
	msg.MIMEType = bodyType
	encrypt, err = msg.Encrypt([]*openpgp.Entity{signer}, signer)
	if err != nil {
		return err
	}
	if _, err = encrypt.Write(body); err != nil {
		encrypt.Close()
		return err
	}
	if err = encrypt.Close(); err != nil {
		return err
	}
	msg, err = s.client.UpdateDraftMessage(msg)
	if err != nil {
		return err
	}
	set := pm.NewMessagePackageSet(keys)
	encrypt, err = set.Encrypt(bodyType, signer)
	if err != nil {
		return err
	}
	if _, err = encrypt.Write(body); err != nil {
		encrypt.Close()
		return err
	}
	if err = encrypt.Close(); err != nil {
		return err
	}
	for _, r := range recipients {
		pub, e := s.client.GetPublicKeys(r)
		if e != nil {
			return e
		}
		var entity *openpgp.Entity
		for _, key := range pub.Keys {
			if key.Send == 1 {
				entity, e = key.Entity()
				if e != nil {
					return e
				}
				break
			}
		}
		if entity != nil {
			if _, e = set.AddInternal(r, entity); e != nil {
				return e
			}
		} else {
			if pub.RecipientType == pm.RecipientInternal {
				return errAuth
			}
			p, e := set.AddCleartext(r)
			if e != nil {
				return e
			}
			p.Signature = 0
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	sent, _, err := s.client.SendMessage(&pm.OutgoingMessage{ID: msg.ID, Packages: []*pm.MessagePackageSet{set}})
	if err != nil {
		return err
	}
	if sent == nil || sent.ID == "" {
		return errSync
	}
	return nil
}
