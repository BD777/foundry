package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/foundry-dev/foundry/apps/server/internal/secretstore"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
)

// runKeys implements `foundry-server keys <subcommand>`. Key files are plain
// local artifacts; rotate and reinitialize also touch the database because the
// KEK pairs with a sealed canary there.
func runKeys(args []string, getenv func(string) string) error {
	if len(args) == 0 {
		printKeysUsage()
		return errors.New("keys: missing subcommand")
	}
	cfg := loadConfig(getenv)
	switch args[0] {
	case "generate":
		return runKeysGenerate(args[1:], cfg)
	case "fingerprint":
		return runKeysFingerprint(cfg)
	case "rotate":
		return runKeysRotate(cfg)
	case "reinitialize":
		return runKeysReinitialize(args[1:], cfg)
	default:
		printKeysUsage()
		return fmt.Errorf("keys: unknown subcommand %q", args[0])
	}
}

func runKeysGenerate(args []string, cfg config) error {
	flags := flag.NewFlagSet("keys generate", flag.ContinueOnError)
	force := flags.Bool("force", false, "replace an existing key file (the old key is kept beside it as .old)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if cfg.SecretKeyPath == "" {
		return errors.New("keys generate: no secret key path (in-memory database)")
	}
	kek, err := secretstore.GenerateKEK()
	if err != nil {
		return err
	}
	if err := secretstore.WriteKEK(cfg.SecretKeyPath, kek, *force); err != nil {
		return err
	}
	fmt.Printf("generated %s\n  fingerprint sha256:%s\n", cfg.SecretKeyPath, kek.Fingerprint)
	if _, err := os.Stat(cfg.DBPath); err == nil {
		fmt.Printf("note: %s already exists; it will refuse to start until the key pairs with it (rotate or reinitialize)\n", cfg.DBPath)
	}
	return nil
}

func runKeysFingerprint(cfg config) error {
	if cfg.SecretKeyPath == "" {
		return errors.New("keys fingerprint: no secret key path (in-memory database)")
	}
	kek, err := secretstore.LoadKEK(cfg.SecretKeyPath)
	if err != nil {
		return err
	}
	fmt.Printf("%s\n  fingerprint sha256:%s\n  created %s\n", cfg.SecretKeyPath, kek.Fingerprint, kek.CreatedAt.Format("2006-01-02T15:04:05Z"))
	return nil
}

// runKeysRotate rotates the KEK in three steps with a crash-safe ordering:
// stage the new key beside the live one, re-wrap the database in one
// transaction, then promote. A crash before promotion self-heals on the next
// store open, which verifies the staged candidate against the new canary.
func runKeysRotate(cfg config) error {
	if cfg.SecretKeyPath == "" {
		return errors.New("keys rotate: no secret key path (in-memory database)")
	}
	st, err := sqlitestore.OpenWithOptions(cfg.DBPath, sqlitestore.Options{SecretKeyPath: cfg.SecretKeyPath})
	if err != nil {
		return err
	}
	defer st.Close()

	old := st.SecretKEKFingerprint()
	next, err := secretstore.GenerateKEK()
	if err != nil {
		return err
	}
	// Stage the new key first: if anything below dies, the staged file is the
	// one the re-wrapped database pairs with.
	if err := secretstore.WriteKEK(cfg.SecretKeyPath+".new", next, true); err != nil {
		return err
	}
	rotated, err := st.RotateSecrets(context.Background(), next)
	if err != nil {
		os.Remove(cfg.SecretKeyPath + ".new")
		return err
	}
	if _, err := secretstore.PromotePendingKEK(cfg.SecretKeyPath); err != nil {
		return fmt.Errorf("rotation committed but the new key file could not be promoted: %v (the staged key is at %s.new; move it into place manually)", err, cfg.SecretKeyPath)
	}
	fmt.Printf("rotated key %s\n  old fingerprint sha256:%s\n  new fingerprint sha256:%s\n  re-wrapped %d secret(s)\n",
		cfg.SecretKeyPath, old, next.Fingerprint, rotated)
	fmt.Println("restart any running server so it adopts the new key")
	return nil
}

// runKeysReinitialize is the lost-key recovery path: it discards every stored
// secret, generates a fresh key, and re-pairs the database with it.
func runKeysReinitialize(args []string, cfg config) error {
	flags := flag.NewFlagSet("keys reinitialize", flag.ContinueOnError)
	acceptDataLoss := flags.Bool("accept-data-loss", false, "required: acknowledges that every stored secret is discarded")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !*acceptDataLoss {
		return errors.New("keys reinitialize: pass --accept-data-loss to discard all stored secrets and re-pair with a fresh key")
	}
	if cfg.SecretKeyPath == "" {
		return errors.New("keys reinitialize: no secret key path (in-memory database)")
	}
	// Open without the key path: the whole point is that the old key is gone.
	st, err := sqlitestore.OpenWithOptions(cfg.DBPath, sqlitestore.Options{})
	if err != nil {
		return err
	}
	defer st.Close()

	next, err := secretstore.GenerateKEK()
	if err != nil {
		return err
	}
	if err := st.ResetSecretStore(context.Background(), next); err != nil {
		return err
	}
	if err := secretstore.WriteKEK(cfg.SecretKeyPath, next, true); err != nil {
		return err
	}
	fmt.Printf("reinitialized %s\n  fingerprint sha256:%s\n  all stored secrets discarded; re-enter them in the UI\n",
		cfg.SecretKeyPath, next.Fingerprint)
	return nil
}

func printKeysUsage() {
	fmt.Fprint(os.Stderr, `usage: foundry-server keys <subcommand>

  generate [--force]              create the key file (refuses to replace one without --force)
  fingerprint                     print the key file's fingerprint and creation time
  rotate                          stage a new key, re-wrap stored secrets, promote
  reinitialize --accept-data-loss discard stored secrets and pair with a fresh key

The key file path defaults to <database directory>/foundry-secret.key and can
be overridden with FOUNDRY_SECRET_KEY_PATH.
`)
}
