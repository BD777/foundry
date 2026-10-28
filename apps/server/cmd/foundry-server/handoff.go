package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// Restart handoff (DEV-062). With FOUNDRY_RESTART_HANDOFF=1 the process the
// service manager runs is a small supervisor: it owns the listening socket
// and runs the server as a child process that inherits it. SIGHUP starts a
// new child from the same executable path (the deployed binary); once that
// child is ready the old one is told to stop, and the new one starts its
// background work after the old one has exited. The socket never closes,
// so a connection that arrives meanwhile waits in its backlog instead of
// being refused: a deploy costs no failed requests.
//
// A plain restart of the supervisor (pm2 restart) still works and is short
// (the server answers within seconds of starting), but refuses connections
// while the old process exits.
const (
	handoffEnv = "FOUNDRY_RESTART_HANDOFF"
	// handoffChildEnv marks a child the supervisor started. Its value is the
	// first of three inherited descriptors: the listening socket, the
	// pipe it reports ready on, and the pipe that closes when the server it
	// replaces has exited.
	handoffChildEnv = "FOUNDRY_HANDOFF_FD"
	// handoffReadyTimeout bounds how long a new child may take to become
	// ready before the supervisor gives up on it and keeps the running one.
	handoffReadyTimeout = 2 * time.Minute
)

// handoffChild is what a supervised server inherits.
type handoffChild struct {
	listener net.Listener
	ready    *os.File
	previous *os.File
}

// inheritedHandoff returns the descriptors a supervised server inherited,
// or nil for a server that was started directly.
func inheritedHandoff(getenv func(string) string) (*handoffChild, error) {
	value := getenv(handoffChildEnv)
	if value == "" {
		return nil, nil
	}
	first, err := strconv.Atoi(value)
	if err != nil || first < 3 {
		return nil, fmt.Errorf("%s=%q is not an inherited descriptor", handoffChildEnv, value)
	}
	socket := os.NewFile(uintptr(first), "listener")
	listener, err := net.FileListener(socket)
	_ = socket.Close() // FileListener holds its own copy.
	if err != nil {
		return nil, fmt.Errorf("inherited listener: %w", err)
	}
	return &handoffChild{
		listener: listener,
		ready:    os.NewFile(uintptr(first+1), "ready"),
		previous: os.NewFile(uintptr(first+2), "previous"),
	}, nil
}

// reportReady tells the supervisor this server answers requests.
func (h *handoffChild) reportReady() {
	_, _ = h.ready.Write([]byte("ready\n"))
	_ = h.ready.Close()
}

// waitForPrevious returns once the server this one replaces has exited, so
// background work (chat queues, Feishu connections, supervision loops)
// never runs in two processes at once.
func (h *handoffChild) waitForPrevious(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, h.previous)
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		_ = h.previous.Close()
		return ctx.Err()
	}
}

// supervisedServer is one child server process.
type supervisedServer struct {
	process *os.Process
	// ready is closed when the child reports it answers requests.
	ready chan struct{}
	// exited receives the child's exit once.
	exited chan error
	// previousGone closes the child's pipe that reports its predecessor
	// has exited.
	previousGone func()
}

// supervisor runs and replaces the server child processes.
type supervisor struct {
	executable string
	args       []string
	socket     *os.File
	logf       func(format string, args ...any)
}

// start runs a child server on the socket. It uses syscall.ForkExec, not
// os/exec: os/exec takes each inherited file's Fd, which switches the file
// to blocking mode, and the socket's mode is shared by every process that
// holds it. The running server's accept would then block in the kernel,
// and closing its listener to stop would wait for the next connection.
func (s *supervisor) start() (*supervisedServer, error) {
	readyRead, readyWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	previousRead, previousWrite, err := os.Pipe()
	if err != nil {
		_ = readyRead.Close()
		_ = readyWrite.Close()
		return nil, err
	}
	defer readyWrite.Close()
	defer previousRead.Close()
	fail := func(err error) (*supervisedServer, error) {
		_ = readyRead.Close()
		_ = previousWrite.Close()
		return nil, err
	}
	files := []uintptr{os.Stdin.Fd(), os.Stdout.Fd(), os.Stderr.Fd()}
	for _, file := range []*os.File{s.socket, readyWrite, previousRead} {
		fd, err := descriptor(file)
		if err != nil {
			return fail(err)
		}
		files = append(files, fd)
	}
	pid, err := syscall.ForkExec(s.executable, append([]string{s.executable}, s.args...), &syscall.ProcAttr{
		Env:   append(os.Environ(), handoffChildEnv+"=3"),
		Files: files,
		// A child outliving its supervisor would hold the port the next
		// one needs.
		Sys: &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM},
	})
	if err != nil {
		return fail(fmt.Errorf("start server %s: %w", s.executable, err))
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return fail(err)
	}
	child := &supervisedServer{
		process:      process,
		ready:        make(chan struct{}),
		exited:       make(chan error, 1),
		previousGone: func() { _ = previousWrite.Close() },
	}
	go func() {
		defer readyRead.Close()
		line := make([]byte, 16)
		if n, _ := readyRead.Read(line); n > 0 {
			close(child.ready)
		}
	}()
	go func() {
		state, err := process.Wait()
		if err == nil && !state.Success() {
			err = childExit{state}
		}
		child.exited <- err
	}()
	return child, nil
}

// descriptor is file's descriptor, read without switching it to blocking
// mode as File.Fd does.
func descriptor(file *os.File) (uintptr, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return 0, err
	}
	var fd uintptr
	if err := raw.Control(func(descriptor uintptr) { fd = descriptor }); err != nil {
		return 0, err
	}
	return fd, nil
}

// childExit is a child's unsuccessful exit.
type childExit struct{ state *os.ProcessState }

func (e childExit) Error() string { return e.state.String() }

// stop asks the child to drain and waits for it to exit.
func (c *supervisedServer) stop() error {
	_ = c.process.Signal(syscall.SIGTERM)
	return <-c.exited
}

// replace starts a new child and, once it is ready, stops current. A child
// that exits or does not become ready in time is discarded and current
// keeps serving.
func (s *supervisor) replace(current *supervisedServer) (*supervisedServer, error) {
	next, err := s.start()
	if err != nil {
		return current, err
	}
	timeout := time.NewTimer(handoffReadyTimeout)
	defer timeout.Stop()
	select {
	case <-next.ready:
	case err := <-next.exited:
		next.previousGone()
		return current, fmt.Errorf("new server exited before it was ready: %v", err)
	case exitErr := <-current.exited:
		// The running server died while its successor started: the
		// successor carries on alone.
		s.logf("restart handoff: running server exited during the handoff: %v", exitErr)
		next.previousGone()
		return next, nil
	case <-timeout.C:
		_ = next.process.Kill()
		<-next.exited
		next.previousGone()
		return current, fmt.Errorf("new server was not ready within %s", handoffReadyTimeout)
	}
	started := time.Now()
	exitErr := current.stop()
	next.previousGone()
	s.logf("restart handoff: new server pid %d took over; previous pid %d exited after %s (%v)",
		next.process.Pid, current.process.Pid, time.Since(started).Round(time.Millisecond), exitErr)
	return next, nil
}

// supervise owns the listening socket and the server child processes until
// ctx is cancelled (SIGINT/SIGTERM), replacing the child on SIGHUP. It
// returns when the child exits on its own, so the service manager restarts
// the whole service.
func supervise(ctx context.Context, cfg config, deps dependencies) error {
	executable, err := supervisedExecutable()
	if err != nil {
		return err
	}
	listener, err := listenRetrying(ctx, deps, cfg.Addr)
	if err != nil {
		return err
	}
	tcp, ok := listener.(*net.TCPListener)
	if !ok {
		_ = listener.Close()
		return errors.New("restart handoff needs a TCP listener")
	}
	socket, err := tcp.File()
	_ = listener.Close() // The duplicate in socket keeps it open.
	if err != nil {
		return fmt.Errorf("restart handoff socket: %w", err)
	}
	defer socket.Close()

	s := &supervisor{executable: executable, args: os.Args[1:], socket: socket, logf: deps.logf}
	hangups := make(chan os.Signal, 1)
	signal.Notify(hangups, syscall.SIGHUP)
	defer signal.Stop(hangups)

	current, err := s.start()
	if err != nil {
		return err
	}
	current.previousGone()
	deps.logf("restart handoff: supervising server pid %d on %s; SIGHUP restarts it from %s without closing the port",
		current.process.Pid, cfg.Addr, executable)
	for {
		select {
		case <-ctx.Done():
			// The child may have had the signal too (a process-group kill).
			if err := current.stop(); err != nil && !exitedOnSignal(err) {
				return err
			}
			return nil
		case err := <-current.exited:
			if err == nil {
				err = errors.New("server exited")
			}
			return fmt.Errorf("supervised server pid %d: %w", current.process.Pid, err)
		case <-hangups:
			deps.logf("restart handoff: SIGHUP, starting a new server from %s", executable)
			next, err := s.replace(current)
			if err != nil {
				deps.logf("restart handoff: kept server pid %d: %v", current.process.Pid, err)
			}
			current = next
		}
	}
}

// supervisedExecutable is the path this process was started from. A deploy
// replaces the file at that path, so the next child runs the new binary
// (os.Executable would name the replaced, deleted file).
func supervisedExecutable() (string, error) {
	path, err := exec.LookPath(os.Args[0])
	if err != nil {
		return "", fmt.Errorf("restart handoff: find executable: %w", err)
	}
	return filepath.Abs(path)
}

func exitedOnSignal(err error) bool {
	var exit childExit
	if !errors.As(err, &exit) {
		return false
	}
	status, ok := exit.state.Sys().(syscall.WaitStatus)
	return ok && status.Signaled()
}

// listenRetrying binds addr, waiting a while for a port the previous
// process still holds (it exits after draining its requests).
func listenRetrying(ctx context.Context, deps dependencies, addr string) (net.Listener, error) {
	deadline := time.Now().Add(listenRetryWindow)
	for {
		listener, err := deps.listen(ctx, addr)
		if err == nil || !errors.Is(err, syscall.EADDRINUSE) || time.Now().After(deadline) {
			return listener, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// listenRetryWindow is how long a start waits for its port: longer than the
// previous server's drain (shutdownTimeout).
const listenRetryWindow = shutdownTimeout + 5*time.Second
