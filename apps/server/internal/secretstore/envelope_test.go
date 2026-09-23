package secretstore

import (
	"bytes"
	"testing"
)

func TestSealOpenRoundtrip(t *testing.T) {
	kek, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("sk-ant-api03-team-relay-credential")
	record, err := Seal(kek, secret, "agent-profile:prof_1")
	if err != nil {
		t.Fatal(err)
	}
	opened, err := Open(kek, record, "agent-profile:prof_1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, secret) {
		t.Fatalf("roundtrip mismatch: %q != %q", opened, secret)
	}
	if bytes.Contains(record.Ciphertext, secret) || bytes.Contains(record.WrappedDEK, secret) {
		t.Fatal("plaintext leaked into the envelope")
	}
}

func TestOpenFailsClosedOnEveryTamperPath(t *testing.T) {
	kek, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	record, err := Seal(kek, []byte("credential"), "scope:a")
	if err != nil {
		t.Fatal(err)
	}
	wrongKey, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		kek KEK
		rec Record
		aad string
	}{
		"wrong key":           {kek: wrongKey, rec: record, aad: "scope:a"},
		"relocated aad":       {kek: kek, rec: record, aad: "scope:b"},
		"tampered ciphertext": {kek: kek, rec: Record{Ciphertext: flip(record.Ciphertext), WrappedDEK: record.WrappedDEK, DEKNonce: record.DEKNonce, CTNonce: record.CTNonce}, aad: "scope:a"},
		"tampered dek wrap":   {kek: kek, rec: Record{Ciphertext: record.Ciphertext, WrappedDEK: flip(record.WrappedDEK), DEKNonce: record.DEKNonce, CTNonce: record.CTNonce}, aad: "scope:a"},
		"swapped nonce":       {kek: kek, rec: Record{Ciphertext: record.Ciphertext, WrappedDEK: record.WrappedDEK, DEKNonce: record.CTNonce, CTNonce: record.DEKNonce}, aad: "scope:a"},
	}
	for name, c := range cases {
		if _, err := Open(c.kek, c.rec, c.aad); err == nil {
			t.Fatalf("%s: open unexpectedly succeeded", name)
		}
	}
}

func TestRewrapKeepsCiphertextAndMovesKey(t *testing.T) {
	oldKEK, newKEK := mustKEK(t), mustKEK(t)
	secret := []byte("credential")
	record, err := Seal(oldKEK, secret, "agent-profile:prof_1")
	if err != nil {
		t.Fatal(err)
	}
	rewrapped, err := Rewrap(oldKEK, newKEK, record, "agent-profile:prof_1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(rewrapped.Ciphertext, record.Ciphertext) {
		t.Fatal("rewrap touched the ciphertext; rotation must only re-wrap the DEK")
	}
	if bytes.Equal(rewrapped.WrappedDEK, record.WrappedDEK) {
		t.Fatal("rewrap kept the old wrapped DEK")
	}
	opened, err := Open(newKEK, rewrapped, "agent-profile:prof_1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, secret) {
		t.Fatal("rewrapped record lost the plaintext")
	}
	if _, err := Open(oldKEK, rewrapped, "agent-profile:prof_1"); err == nil {
		t.Fatal("old key still opens a rewrapped record")
	}
	if _, err := Rewrap(newKEK, oldKEK, record, "agent-profile:prof_1"); err == nil {
		t.Fatal("rewrap with the wrong old key unexpectedly succeeded")
	}
}

func TestCanaryBindsToItsOwnIdentity(t *testing.T) {
	kek := mustKEK(t)
	canary, err := SealCanary(kek)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyCanary(kek, canary) {
		t.Fatal("fresh canary failed verification")
	}
	other, err := Seal(kek, []byte(CanaryPlaintext), "agent-profile:prof_1")
	if err != nil {
		t.Fatal(err)
	}
	if VerifyCanary(kek, other) {
		t.Fatal("a non-canary record passed canary verification")
	}
	forged, err := Seal(mustKEK(t), []byte(CanaryPlaintext), CanaryAAD)
	if err != nil {
		t.Fatal(err)
	}
	if VerifyCanary(kek, forged) {
		t.Fatal("canary sealed with a different key passed verification")
	}
}

func mustKEK(t *testing.T) KEK {
	t.Helper()
	kek, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	return kek
}

func flip(b []byte) []byte {
	out := make([]byte, len(b))
	copy(out, b)
	out[0] ^= 0xff
	return out
}
