//go:build !linux

package main

import "syscall"

// handoffChildSysProcAttr: only Linux can tie a child's life to its parent;
// elsewhere (a developer's macOS build) the supervisor stops the child itself.
func handoffChildSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}
