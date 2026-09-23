package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestUsersCreateListAndResetPassword(t *testing.T) {
	dbPath := t.TempDir() + "/foundry.db"
	getenv := func(key string) string {
		if key == "FOUNDRY_DB_PATH" {
			return dbPath
		}
		return ""
	}

	var out bytes.Buffer
	if err := runUsers([]string{"create", "--username", "admin", "--role", "admin"}, getenv, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "created admin admin") || !strings.Contains(out.String(), "password: ") {
		t.Fatalf("create output = %q", out.String())
	}

	out.Reset()
	if err := runUsers([]string{"create", "--username", "member1", "--password-stdin"}, getenv, strings.NewReader("short\n"), &out); err == nil {
		t.Fatal("a weak stdin password must be rejected")
	}
	if err := runUsers([]string{"create", "--username", "member1", "--password-stdin"}, getenv, strings.NewReader("long enough password\n"), &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "password: ") {
		t.Fatalf("a supplied password must not be echoed: %q", out.String())
	}
	if err := runUsers([]string{"create", "--username", "ADMIN"}, getenv, strings.NewReader(""), &out); err == nil {
		t.Fatal("duplicate username must fail")
	}

	out.Reset()
	if err := runUsers([]string{"list"}, getenv, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "admin") || !strings.Contains(out.String(), "member1") {
		t.Fatalf("list output = %q", out.String())
	}

	out.Reset()
	if err := runUsers([]string{"reset-password", "--username", "admin"}, getenv, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "reset password for admin") {
		t.Fatalf("reset output = %q", out.String())
	}
	if err := runUsers([]string{"reset-password", "--username", "ghost"}, getenv, strings.NewReader(""), &out); err == nil {
		t.Fatal("resetting an unknown user must fail")
	}
}

func TestDevicesPairingTokenIsRedeemableOnce(t *testing.T) {
	dbPath := t.TempDir() + "/foundry.db"
	getenv := func(key string) string {
		if key == "FOUNDRY_DB_PATH" {
			return dbPath
		}
		return ""
	}
	var out bytes.Buffer
	if err := runDevices([]string{"pairing-token", "--username", "nobody"}, getenv, &out); err == nil {
		t.Fatal("an unknown account must not receive a pairing token")
	}
	if err := runUsers([]string{"create", "--username", "admin", "--role", "admin"}, getenv, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := runDevices([]string{"pairing-token", "--username", "admin"}, getenv, &out); err != nil {
		t.Fatal(err)
	}
	token := strings.TrimSpace(out.String())
	if len(token) < 40 {
		t.Fatalf("token = %q", token)
	}
	st, err := sqlitestore.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	input := store.PairDeviceInput{TokenHash: accounts.HashToken(token), MachineFingerprint: "m", CredentialHash: "c", Now: time.Now()}
	if _, err := st.PairDevice(context.Background(), input); err != nil {
		t.Fatalf("redeem token: %v", err)
	}
	input.CredentialHash = "c2"
	if _, err := st.PairDevice(context.Background(), input); !errors.Is(err, store.ErrDevicePairingInvalid) {
		t.Fatalf("second redemption err = %v", err)
	}
}
