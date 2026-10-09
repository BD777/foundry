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
// Arguments are parsed before the store opens, so help and typos never create
// or migrate a database.
func runUsers(args []string, getenv func(string) string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 {
		printUsersUsage()
		return errors.New("users: missing subcommand")
	}
	var command usersCommand
	var err error
	switch args[0] {
	case "list":
		command = func(ctx context.Context, st store.AccountStore) error { return runUsersList(ctx, st, stdout) }
	case "create":
		command, err = parseUsersCreate(args[1:], stdin, stdout)
	case "reset-password":
		command, err = parseUsersResetPassword(args[1:], stdin, stdout)
	default:
		printUsersUsage()
		if isHelpArg(args[0]) {
			return flag.ErrHelp
		}
		return fmt.Errorf("users: unknown subcommand %q", args[0])
	}
	if err != nil {
		return err
	}
	cfg := loadConfig(getenv)
	if err := checkDataLocation(cfg, fileExists); err != nil {
		return err
	}
	st, err := sqlitestore.OpenWithOptions(cfg.DBPath, sqlitestore.Options{})
	if err != nil {
		return err
	}
	defer st.Close()
	return command(context.Background(), st)
}

// usersCommand runs one parsed `users` subcommand against the opened store.
type usersCommand func(ctx context.Context, st store.AccountStore) error

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

func parseUsersCreate(args []string, stdin io.Reader, stdout io.Writer) (usersCommand, error) {
	flags := flag.NewFlagSet("users create", flag.ContinueOnError)
	username := flags.String("username", "", "login name (required)")
	displayName := flags.String("display-name", "", "name shown in the app (defaults to the username)")
	role := flags.String("role", store.RoleMember, "admin or member")
	passwordStdin := flags.Bool("password-stdin", false, "read the password from the first line of stdin instead of generating one")
	if err := flags.Parse(args); err != nil {
		return nil, err
	}
	if err := accounts.ValidateUsername(*username); err != nil {
		return nil, err
	}
	if !store.ValidRole(*role) {
		return nil, fmt.Errorf("users create: role must be %s or %s", store.RoleAdmin, store.RoleMember)
	}
	if err := accounts.ValidateDisplayName(*displayName); err != nil {
		return nil, err
	}
	return func(ctx context.Context, st store.AccountStore) error {
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
	}, nil
}

func parseUsersResetPassword(args []string, stdin io.Reader, stdout io.Writer) (usersCommand, error) {
	flags := flag.NewFlagSet("users reset-password", flag.ContinueOnError)
	username := flags.String("username", "", "login name (required)")
	passwordStdin := flags.Bool("password-stdin", false, "read the password from the first line of stdin instead of generating one")
	if err := flags.Parse(args); err != nil {
		return nil, err
	}
	return func(ctx context.Context, st store.AccountStore) error {
		return resetUserPassword(ctx, st, *username, *passwordStdin, stdin, stdout)
	}, nil
}

func resetUserPassword(ctx context.Context, st store.AccountStore, username string, passwordStdin bool, stdin io.Reader, stdout io.Writer) error {
	user, _, err := st.GetUserCredentials(ctx, username)
	if err != nil {
		return err
	}
	password, generated, err := resolvePassword(passwordStdin, stdin)
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
The database path follows FOUNDRY_DB_PATH (default <state root>/server/foundry.db, where the
state root is FOUNDRY_STATE_ROOT, ~/.foundry-stacks/<FOUNDRY_STACK> or ~/.foundry).
`)
}
