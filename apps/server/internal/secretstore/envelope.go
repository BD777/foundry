package secretstore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
)

const (
	nonceBytes = 12 // GCM standard nonce size
	dekBytes   = 32 // one AES-256 data key per secret
)

// CanaryPlaintext is the fixed payload sealed into the store metadata at
// initialization. Verifying it proves "this key file pairs with this database"
// at startup, before any real secret is needed.
const CanaryPlaintext = "foundry-secret-store-canary-v1"

// CanaryAAD binds the canary to its role so a record copied from a secret row
// can never stand in for it.
const CanaryAAD = "canary"

// Record is one envelope-sealed secret: the DEK-encrypted ciphertext plus the
// KEK-wrapped DEK. Stored opaquely by the persistence layer.
type Record struct {
	Ciphertext []byte
	WrappedDEK []byte
	DEKNonce   []byte
	CTNonce    []byte
}

// Seal encrypts plaintext under a fresh random DEK and wraps that DEK with
// kek. The additional data binds the record to its storage identity (for
// example "agent-profile:<id>"), so a valid record cannot be relocated.
func Seal(kek KEK, plaintext []byte, additionalData string) (Record, error) {
	var record Record
	dek, err := randomBytes(dekBytes)
	if err != nil {
		return Record{}, err
	}
	record.DEKNonce, err = randomBytes(nonceBytes)
	if err != nil {
		return Record{}, err
	}
	record.CTNonce, err = randomBytes(nonceBytes)
	if err != nil {
		return Record{}, err
	}
	dataAEAD, err := gcm(dek)
	if err != nil {
		return Record{}, err
	}
	record.Ciphertext = dataAEAD.Seal(nil, record.CTNonce, plaintext, []byte(additionalData))
	wrapAEAD, err := gcm(kek.Key[:])
	if err != nil {
		return Record{}, err
	}
	record.WrappedDEK = wrapAEAD.Seal(nil, record.DEKNonce, dek, []byte(additionalData))
	return record, nil
}

// Open unwraps the DEK with kek and decrypts the ciphertext. It fails closed
// on any tampering, wrong KEK, or additional-data mismatch; the caller cannot
// distinguish which, by design.
func Open(kek KEK, record Record, additionalData string) ([]byte, error) {
	wrapAEAD, err := gcm(kek.Key[:])
	if err != nil {
		return nil, err
	}
	dek, err := wrapAEAD.Open(nil, record.DEKNonce, record.WrappedDEK, []byte(additionalData))
	if err != nil {
		return nil, fmt.Errorf("unwrap data key: %w", err)
	}
	dataAEAD, err := gcm(dek)
	if err != nil {
		return nil, err
	}
	plaintext, err := dataAEAD.Open(nil, record.CTNonce, record.Ciphertext, []byte(additionalData))
	if err != nil {
		return nil, fmt.Errorf("decrypt secret: %w", err)
	}
	return plaintext, nil
}

// Rewrap re-wraps the DEK under newKEK without touching the ciphertext. This
// is the whole point of the envelope layer: KEK rotation and future key-source
// changes re-wrap 32 bytes per record instead of re-encrypting secrets.
func Rewrap(oldKEK KEK, newKEK KEK, record Record, additionalData string) (Record, error) {
	wrapAEAD, err := gcm(oldKEK.Key[:])
	if err != nil {
		return Record{}, err
	}
	dek, err := wrapAEAD.Open(nil, record.DEKNonce, record.WrappedDEK, []byte(additionalData))
	if err != nil {
		return Record{}, fmt.Errorf("unwrap data key: %w", err)
	}
	newAEAD, err := gcm(newKEK.Key[:])
	if err != nil {
		return Record{}, err
	}
	rewrapped := Record{
		Ciphertext: record.Ciphertext,
		CTNonce:    record.CTNonce,
	}
	rewrapped.DEKNonce, err = randomBytes(nonceBytes)
	if err != nil {
		return Record{}, err
	}
	rewrapped.WrappedDEK = newAEAD.Seal(nil, rewrapped.DEKNonce, dek, []byte(additionalData))
	return rewrapped, nil
}

// SealCanary and VerifyCanary wrap the store pairing check so callers never
// handcraft the canary's identity binding.
func SealCanary(kek KEK) (Record, error) {
	return Seal(kek, []byte(CanaryPlaintext), CanaryAAD)
}

func VerifyCanary(kek KEK, record Record) bool {
	plaintext, err := Open(kek, record, CanaryAAD)
	return err == nil && string(plaintext) == CanaryPlaintext
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("init aes: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("init gcm: %w", err)
	}
	return aead, nil
}

func randomBytes(n int) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("read random: %w", err)
	}
	return buf, nil
}
