package protonmail

import (
	"bytes"
	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"strings"
	"testing"
)

func TestPrivateKeyTokenExpansionBound(t *testing.T) {
	entity, err := openpgp.NewEntity("Fixture", "", "fixture@example.test", &packet.Config{Algorithm: packet.PubKeyAlgoEdDSA})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	armored, err := armor.Encode(&output, "PGP MESSAGE", nil)
	if err != nil {
		t.Fatal(err)
	}
	compressed, err := packet.SerializeCompressed(armored, packet.CompressionZLIB, nil)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := packet.SerializeLiteral(compressed, true, "fixture", 0)
	if err != nil {
		t.Fatal(err)
	}
	writer.Write(bytes.Repeat([]byte("x"), 128*1024))
	writer.Close()
	armored.Close()
	_, err = decryptPrivateKeyToken(&PrivateKey{Token: output.String()}, openpgp.EntityList{entity})
	if err == nil || !strings.Contains(err.Error(), "token size limit") {
		t.Fatalf("expected bounded token failure, got %v", err)
	}
}
