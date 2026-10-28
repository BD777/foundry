package httpapi

import (
	"context"
	"crypto/subtle"
	"io"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// previewRouteCheckPath answers only the probe this Server sent itself.
const previewRouteCheckPath = "/__foundry/route-check"

// previewRoute records whether service hosts actually reach this Server
// through the public edge (DNS, TLS, ingress). Until a probe comes back,
// service URLs are withheld: an Open link that lands on someone else's
// catch-all page is worse than none.
type previewRoute struct {
	// checking is set once RunPreviewRouteCheck starts; a Server that never
	// probes (tests, embedded use) treats configured hosts as routed.
	checking atomic.Bool
	routed   atomic.Bool
	mu       sync.Mutex
	label    string
	nonce    string
}

func (s *Server) previewRouted() bool {
	return !s.previewProbe.checking.Load() || s.previewProbe.routed.Load()
}

// RunPreviewRouteCheck probes https://probe-<random>.<preview domain> at
// start, then every five minutes while routed and every 30 seconds while not.
func (s *Server) RunPreviewRouteCheck(ctx context.Context) {
	if s.previewDomain() == "" {
		return
	}
	s.previewProbe.checking.Store(true)
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for first := true; ; first = false {
		routed := s.checkPreviewRoute(ctx, client)
		if routed != s.previewProbe.routed.Swap(routed) || first {
			log.Printf("service web access: public route to this server %s", map[bool]string{true: "verified", false: "not reachable"}[routed])
		}
		wait := 30 * time.Second
		if routed {
			wait = 5 * time.Minute
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (s *Server) checkPreviewRoute(ctx context.Context, client *http.Client) bool {
	domain := s.previewDomain()
	if domain == "" {
		return false
	}
	label, nonce := "probe-"+tunnelRandom()[:32], tunnelRandom()
	p := &s.previewProbe
	p.mu.Lock()
	p.label, p.nonce = label, nonce
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.label, p.nonce = "", ""
		p.mu.Unlock()
	}()
	request, err := http.NewRequestWithContext(ctx, "GET", "https://"+label+"."+domain+previewRouteCheckPath, nil)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 256))
	return response.StatusCode == http.StatusOK && subtle.ConstantTimeCompare(body, []byte(nonce)) == 1
}

// answerPreviewProbe serves the nonce for the label in flight, nothing else.
func (s *Server) answerPreviewProbe(w http.ResponseWriter, r *http.Request, label string) bool {
	if r.URL.Path != previewRouteCheckPath {
		return false
	}
	p := &s.previewProbe
	p.mu.Lock()
	expected, nonce := p.label, p.nonce
	p.mu.Unlock()
	if expected == "" || subtle.ConstantTimeCompare([]byte(label), []byte(expected)) != 1 {
		http.NotFound(w, r)
		return true
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, nonce)
	return true
}
