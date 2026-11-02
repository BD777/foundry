package httpapi

import (
	"context"
	"log"
	"time"
)

// Idle sessions' new events are compacted (store.SessionEventCompactionStore)
// every sessionEventCompactionInterval, the first time a minute after the
// server starts. A run takes up to sessionEventCompactionBatch sessions, a
// turn per transaction; while sessions are left (the first runs after an
// upgrade compact everything stored before), the next run follows after
// sessionEventCompactionPause.
const (
	sessionEventCompactionInterval = 10 * time.Minute
	sessionEventCompactionBatch    = 50
	sessionEventCompactionPause    = 5 * time.Second
)

func (s *Server) runSessionEventCompaction(ctx context.Context) {
	wait := time.Minute
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = sessionEventCompactionInterval
		started := time.Now()
		report, err := s.store.CompactSessionEvents(ctx, started, sessionEventCompactionBatch)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("session event compaction: %v", err)
			}
			continue
		}
		if report.Remaining > 0 {
			wait = sessionEventCompactionPause
		}
		if report.Removed > 0 || report.Rewritten > 0 || report.Conflicts > 0 {
			log.Printf("session event compaction: %d sessions in %s, %d events removed, %d rewritten, %d changed meanwhile, %d left",
				report.Sessions, time.Since(started).Round(time.Millisecond), report.Removed, report.Rewritten, report.Conflicts, report.Remaining)
		}
	}
}
