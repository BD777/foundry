package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

const serverUsage = `usage: foundry-server [command]

Without a command, serves the Foundry control plane on FOUNDRY_HOST:PORT
(default 127.0.0.1:31982).

Commands:
  users     list, create and reset accounts
  devices   issue a one-time worker pairing token
  keys      manage the secret-store key file

Run foundry-server <command> --help for its options. The database path follows
FOUNDRY_DB_PATH (default <state root>/server/foundry.db, where the state root is
FOUNDRY_STATE_ROOT, ~/.foundry-stacks/<FOUNDRY_STACK> or ~/.foundry).
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	code := runCommand(ctx, os.Args[1:], defaultDependencies(), os.Stdin, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// runCommand resolves the command line and returns the process exit code.
// Help and unrecognised arguments are answered before any store is opened, so
// they never create or migrate a database.
func runCommand(ctx context.Context, args []string, deps dependencies, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		if err := run(ctx, deps); err != nil {
			deps.logf("%v", err)
			return 1
		}
		return 0
	}
	var err error
	switch command := args[0]; {
	case isHelpArg(command):
		fmt.Fprint(stdout, serverUsage)
		return 0
	case command == "keys":
		err = runKeys(args[1:], deps.getenv)
	case command == "devices":
		err = runDevices(args[1:], deps.getenv, stdout)
	case command == "users":
		err = runUsers(args[1:], deps.getenv, stdin, stdout)
	default:
		fmt.Fprintf(stderr, "foundry-server: unknown argument %q\n\n%s", command, serverUsage)
		return 2
	}
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func isHelpArg(arg string) bool {
	switch arg {
	case "-h", "-help", "--help", "help":
		return true
	}
	return false
}
