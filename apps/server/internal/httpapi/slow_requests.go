package httpapi

import (
	"log"
	"net/http"
	"strings"
	"time"
)

// slowRequestThreshold is when an ordinary request is worth a log line: with
// one database connection, a request this slow is usually waiting for it.
const slowRequestThreshold = time.Second

// withSlowRequestLog logs ordinary requests that take longer than the
// threshold. Event streams and WebSocket upgrades stay open by design and are
// not timed.
func withSlowRequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "" || strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			next.ServeHTTP(w, r)
			return
		}
		started := time.Now()
		next.ServeHTTP(w, r)
		if elapsed := time.Since(started); elapsed >= slowRequestThreshold {
			log.Printf("slow request: %s %s took %s", r.Method, r.URL.Path, elapsed.Round(time.Millisecond))
		}
	})
}
