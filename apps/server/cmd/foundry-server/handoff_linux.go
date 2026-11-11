package main

import "syscall"

// handoffChildSysProcAttr ends the server child with its supervisor.
func handoffChildSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}
