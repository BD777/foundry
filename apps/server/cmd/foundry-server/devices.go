package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
)

// Tokens printed on a host shell may be pasted into deploy files, so they
// live longer than the web app's but still expire the same day.
const cliPairingTokenTTL = time.Hour

// runDevices implements `foundry-server devices <subcommand>`: issuing a
// one-time worker pairing token without the web app (containers, scripts).
func runDevices(args []string, getenv func(string) string, stdout io.Writer) error {
	if len(args) == 0 || args[0] != "pairing-token" {
		printDevicesUsage()
		return errors.New("devices: expected subcommand pairing-token")
	}
	flags := flag.NewFlagSet("devices pairing-token", flag.ContinueOnError)
	username := flags.String("username", "", "account that will own the paired device (required)")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	cfg := loadConfig(getenv)
	st, err := sqlitestore.OpenWithOptions(cfg.DBPath, sqlitestore.Options{})
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	user, _, err := st.GetUserCredentials(ctx, *username)
	if err != nil {
		return fmt.Errorf("devices pairing-token: %w", err)
	}
	if !user.Active() {
		return fmt.Errorf("devices pairing-token: %s is disabled", user.Username)
	}
	token, err := accounts.NewToken()
	if err != nil {
		return err
	}
	expiresAt := time.Now().UTC().Add(cliPairingTokenTTL)
	if err := st.CreateDevicePairingToken(ctx, accounts.HashToken(token), user.ID, expiresAt); err != nil {
		return err
	}
	fmt.Fprintln(stdout, token)
	return nil
}

func printDevicesUsage() {
	fmt.Fprint(os.Stderr, `usage: foundry-server devices pairing-token --username NAME

Prints a one-time worker pairing token owned by NAME, valid for one hour.
Pass it to foundry-worker setup --token (or FOUNDRY_PAIRING_TOKEN).
`)
}
