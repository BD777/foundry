package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// runDB implements `foundry-server db <subcommand>`: storage maintenance an
// operator runs (docs/refactor/storage-compression.md).
func runDB(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer) error {
	if len(args) == 0 || isHelpArg(args[0]) {
		printDBUsage(stdout)
		if len(args) == 0 {
			return errors.New("db: expected subcommand compact or vacuum")
		}
		return flag.ErrHelp
	}
	command := args[0]
	flags := flag.NewFlagSet("db "+command, flag.ContinueOnError)
	force := flags.Bool("force", false, "vacuum even though a server answers on FOUNDRY_HOST:PORT")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if command != "compact" && command != "vacuum" {
		printDBUsage(stdout)
		return fmt.Errorf("db: unknown subcommand %q", command)
	}
	cfg := loadConfig(getenv)
	if command == "vacuum" && !*force && serverAnswers(cfg.Addr) {
		return fmt.Errorf("db vacuum: a server answers on %s; stop it first (vacuum holds the database for its whole run), or pass --force if that server serves another database", cfg.Addr)
	}
	st, err := sqlitestore.OpenAdmin(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.PrepareSessionEventCompaction(ctx); err != nil {
		return err
	}
	if err := compactAllSessionEvents(ctx, st, stdout); err != nil {
		return err
	}
	if command == "compact" {
		return nil
	}
	return vacuumDB(ctx, st, cfg.DBPath, stdout)
}

// compactAllSessionEvents compacts every idle session's events, reporting
// each batch.
func compactAllSessionEvents(ctx context.Context, st store.SessionEventCompactionStore, stdout io.Writer) error {
	started := time.Now()
	var total store.SessionEventCompaction
	for {
		report, err := st.CompactSessionEvents(ctx, time.Now(), 100)
		if err != nil {
			return fmt.Errorf("compact session events: %w", err)
		}
		total.Sessions += report.Sessions
		total.Removed += report.Removed
		total.Rewritten += report.Rewritten
		total.Conflicts += report.Conflicts
		fmt.Fprintf(stdout, "compacted %d sessions (%d events removed, %d rewritten), %d to go\n",
			total.Sessions, total.Removed, total.Rewritten, report.Remaining)
		if report.Remaining == 0 || report.Sessions == 0 {
			break
		}
	}
	fmt.Fprintf(stdout, "session events compacted in %s: %d sessions, %d events removed, %d rewritten, %d changed meanwhile (compacted later)\n",
		time.Since(started).Round(time.Millisecond), total.Sessions, total.Removed, total.Rewritten, total.Conflicts)
	return nil
}

func vacuumDB(ctx context.Context, st *sqlitestore.Store, path string, stdout io.Writer) error {
	stats, err := st.FileStats(ctx)
	if err != nil {
		return err
	}
	size := stats.PageSize * stats.Pages
	used := size - stats.PageSize*stats.FreePages
	// A temporary copy of what is used, then as much again in the
	// write-ahead log before it is folded back.
	if free, err := freeBytes(filepath.Dir(path)); err == nil && free < 2*used+(64<<20) {
		return fmt.Errorf("db vacuum: %s free next to the database, it needs about %s (twice the %s in use)", mib(free), mib(2*used), mib(used))
	}
	fmt.Fprintf(stdout, "vacuuming %s: %s, %s of it free pages\n", path, mib(size), mib(stats.PageSize*stats.FreePages))
	started := time.Now()
	if err := st.Vacuum(ctx); err != nil {
		return err
	}
	after, err := os.Stat(path)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "vacuumed in %s: %s -> %s\n", time.Since(started).Round(time.Millisecond), mib(size), mib(after.Size()))
	return nil
}

func serverAnswers(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func freeBytes(dir string) (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dir, &stat); err != nil {
		return 0, err
	}
	return int64(stat.Bavail) * int64(stat.Bsize), nil
}

func mib(bytes int64) string {
	return fmt.Sprintf("%.1f MiB", float64(bytes)/(1<<20))
}

func printDBUsage(stdout io.Writer) {
	fmt.Fprint(stdout, `usage: foundry-server db compact
       foundry-server db vacuum [--force]

compact  removes what idle sessions' transcripts store more than once
         (a running server also does this in the background). Safe beside
         a running server: it writes a turn per short transaction.
vacuum   compacts, then rebuilds the database file so the space it freed is
         returned to the disk. Stop the server first: it holds the database
         for the whole run (about 20 s per GB) and needs free disk of about
         twice the database's used size meanwhile.
`)
}
