package httpapi

import (
	"context"
	"log"
	"time"
)

// personNoticePumpInterval is how often the dispatcher sends the notices
// that are due (DEV-294). The shortest retry wait is 30 seconds.
const personNoticePumpInterval = 10 * time.Second

// pumpPersonNotices sends the due person notices and records what came back.
func (s *Server) pumpPersonNotices(ctx context.Context) {
	if err := s.personNotices.Pump(ctx); err != nil && ctx.Err() == nil {
		log.Printf("person notices: %v", err)
	}
}
