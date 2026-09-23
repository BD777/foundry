package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "keys" {
		if err := runKeys(os.Args[2:], os.Getenv); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "devices" {
		if err := runDevices(os.Args[2:], os.Getenv, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "users" {
		if err := runUsers(os.Args[2:], os.Getenv, os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, defaultDependencies()); err != nil {
		log.Fatal(err)
	}
}
