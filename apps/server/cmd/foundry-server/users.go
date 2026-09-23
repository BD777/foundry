package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// runUsers implements `foundry-server users <subcommand>`, the operator path
// for accounts that does not go through the web app (bootstrap, recovery).
func runUsers(args []string, getenv func(string) string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 {
		printUsersUsage()
		return errors.New("users: missing subcommand")
	}
	cfg := loadConfig(getenv)
	st, err := sqlitestore.OpenWithOptions(cfg.DBPath, sqlitestore.Options{})
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	switch args[0] {
	case "list":
		return runUsersList(ctx, st, stdout)
	case "create":
		return runUsersCreate(ctx, st, args[1:], stdin, stdout)
	case "reset-password":
		return runUsersResetPassword(ctx, st, args[1:], stdin, stdout)
	default:
		printUsersUsage()
		return fmt.Errorf("users: unknown subcommand %q", args[0])
	}
}

func runUsersList(ctx context.Context, st store.AccountStore, stdout io.Writer) error {
	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	table := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "USERNAME\tDISPLAY NAME\tROLE\tSTATUS\tCREATED")
	for _, user := range users {
		status := "active"
		if !user.Active() {
			status = "disabled"
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\n", user.Username, user.DisplayName, user.Role, status, user.CreatedAt.Format("2006-01-02"))
	}
	return table.Flush()
}

func runUsersCreate(ctx context.Context, st store.AccountStore, args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("users create", flag.ContinueOnError)
	username := flags.String("username", "", "login name (required)")
	displayName := flags.String("display-name", "", "name shown in the app (defaults to the username)")
	role := flags.String("role", store.RoleMember, "admin or member")
	passwordStdin := flags.Bool("password-stdin", false, "read the password from the first line of stdin instead of generating one")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if err := accounts.ValidateUsername(*username); err != nil {
		return err
	}
	if !store.ValidRole(*role) {
		return fmt.Errorf("users create: role must be %s or %s", store.RoleAdmin, store.RoleMember)
	}
	if err := accounts.ValidateDisplayName(*displayName); err != nil {
		return err
	}
	password, generated, err := resolvePassword(*passwordStdin, stdin)
	if err != nil {
		return err
	}
	hash, err := accounts.HashPassword(password)
	if err != nil {
		return err
	}
	user, err := st.CreateUser(ctx, store.NewUser{Username: *username, DisplayName: *displayName, Role: *role, PasswordHash: hash})
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "created %s %s (%s)\n", user.Role, user.Username, user.ID)
	if generated {
		fmt.Fprintf(stdout, "  password: %s\n", password)
	}
	return nil
}

func runUsersResetPassword(ctx context.Context, st store.AccountStore, args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("users reset-password", flag.ContinueOnError)
	username := flags.String("username", "", "login name (required)")
	passwordStdin := flags.Bool("password-stdin", false, "read the password from the first line of stdin instead of generating one")
	if err := flags.Parse(args); err != nil {
		return err
	}
	user, _, err := st.GetUserCredentials(ctx, *username)
	if err != nil {
		return err
	}
	password, generated, err := resolvePassword(*passwordStdin, stdin)
	if err != nil {
		return err
	}
	hash, err := accounts.HashPassword(password)
	if err != nil {
		return err
	}
	if err := st.SetUserPassword(ctx, user.ID, hash); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "reset password for %s; existing sessions were signed out\n", user.Username)
	if generated {
		fmt.Fprintf(stdout, "  password: %s\n", password)
	}
	return nil
}

func resolvePassword(fromStdin bool, stdin io.Reader) (string, bool, error) {
	if !fromStdin {
		password, err := generatePassword()
		return password, true, err
	}
	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", false, fmt.Errorf("read password: %w", err)
	}
	password := strings.TrimRight(line, "\r\n")
	if err := accounts.ValidatePassword(password); err != nil {
		return "", false, err
	}
	return password, false, nil
}

func generatePassword() (string, error) {
	// 32 symbols divide 256 evenly, so byte%32 is unbiased; 24 chars = 120 bits.
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789A"
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate password: %w", err)
	}
	for i, b := range raw {
		raw[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(raw), nil
}

func printUsersUsage() {
	fmt.Fprint(os.Stderr, `usage: foundry-server users <subcommand>

  list                                                     list accounts
  create --username NAME [--role admin|member]
         [--display-name NAME] [--password-stdin]          create an account
  reset-password --username NAME [--password-stdin]        set a new password and sign out every session

Without --password-stdin a random password is generated and printed once.
The database path follows FOUNDRY_DB_PATH (default .data/foundry.db).
`)
}
