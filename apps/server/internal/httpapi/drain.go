package httpapi

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Draining (DEV-100). A restart handoff stops the old server within a second
// or two only if nothing keeps a request open. Event streams, WebSockets and
// tunnels end through Shutdown; a request that waits for something else
// watches draining instead, and ends with an answer its caller retries.
// Without that, http.Server's
// Shutdown ran out its whole budget, the old process exited 1 and the proxy
// answered 502 to every request it then cut.

// drainState is whether the server is draining, and which requests are open.
// The zero value is ready to use.
type drainState struct {
	mu    sync.Mutex
	begun bool
	done  chan struct{}
	next  uint64
	open  map[uint64]openRequest
}

type openRequest struct {
	method, path string
	since        time.Time
}

// signal is closed once the server starts draining.
func (d *drainState) signal() <-chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.signalLocked()
}

func (d *drainState) signalLocked() chan struct{} {
	if d.done == nil {
		d.done = make(chan struct{})
	}
	return d.done
}

func (d *drainState) begin() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.begun {
		d.begun = true
		close(d.signalLocked())
	}
}

// track records requests while they run. Upgrades are skipped: a hijacked
// connection leaves http.Server's accounting, so it is no reason to wait.
func (d *drainState) track(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "" {
			next.ServeHTTP(w, r)
			return
		}
		d.mu.Lock()
		id := d.next
		d.next++
		if d.open == nil {
			d.open = map[uint64]openRequest{}
		}
		d.open[id] = openRequest{method: r.Method, path: r.URL.Path, since: time.Now()}
		d.mu.Unlock()
		defer func() {
			d.mu.Lock()
			delete(d.open, id)
			d.mu.Unlock()
		}()
		next.ServeHTTP(w, r)
	})
}

// Draining is closed once Shutdown has begun.
func (s *Server) Draining() <-chan struct{} { return s.drain.signal() }

// OpenRequests describes the requests still running, oldest first, for the
// log of a shutdown that ran out of time.
func (s *Server) OpenRequests() []string {
	s.drain.mu.Lock()
	open := make([]openRequest, 0, len(s.drain.open))
	for _, request := range s.drain.open {
		open = append(open, request)
	}
	s.drain.mu.Unlock()
	sort.Slice(open, func(i, j int) bool { return open[i].since.Before(open[j].since) })
	lines := make([]string, len(open))
	for index, request := range open {
		lines[index] = fmt.Sprintf("%s %s open for %s", request.method, request.path, time.Since(request.since).Round(time.Millisecond))
	}
	return lines
}
