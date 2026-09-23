// Package accounts holds the credential primitives shared by the HTTP API and
// the foundry-server CLI: password hashing, opaque token minting and input
// rules. Storage lives behind store.AccountStore.
package accounts

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const (
	MinPasswordLength = 10
	// bcrypt ignores input beyond 72 bytes; reject instead of truncating.
	MaxPasswordBytes = 72
	bcryptCost       = 12
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$`)

var (
	ErrInvalidUsername    = errors.New("username must be 3-32 characters: letters, digits, '.', '_' or '-', starting with a letter or digit")
	ErrPasswordTooShort   = fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	ErrPasswordTooLong    = fmt.Errorf("password must be at most %d bytes", MaxPasswordBytes)
	ErrDisplayNameTooLong = errors.New("display name must be at most 64 characters")
)

func ValidateUsername(username string) error {
	if !usernamePattern.MatchString(username) {
		return ErrInvalidUsername
	}
	return nil
}

func ValidatePassword(password string) error {
	if utf8.RuneCountInString(password) < MinPasswordLength {
		return ErrPasswordTooShort
	}
	if len(password) > MaxPasswordBytes {
		return ErrPasswordTooLong
	}
	return nil
}

func ValidateDisplayName(name string) error {
	if utf8.RuneCountInString(strings.TrimSpace(name)) > 64 {
		return ErrDisplayNameTooLong
	}
	return nil
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

func VerifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// dummyHash lets login spend the same bcrypt time for unknown usernames, so
// response timing does not reveal which usernames exist.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("foundry-timing-equalizer"), bcryptCost)

func SpendVerifyTime(password string) {
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
}

// NewToken returns a URL-safe random token with 256 bits of entropy.
func NewToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// HashToken is the only form of a session or invite token that is persisted.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewSetupCode returns a short human-typable one-time code for creating the
// first owner, e.g. "7KQ2-M9XD-4TRA".
func NewSetupCode() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate setup code: %w", err)
	}
	var builder strings.Builder
	for i, b := range raw {
		if i > 0 && i%4 == 0 {
			builder.WriteByte('-')
		}
		builder.WriteByte(alphabet[int(b)%len(alphabet)])
	}
	return builder.String(), nil
}
