package httpapi

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/usagestats"
)

// backgroundJob is work the server runs by itself for as long as it serves.
// Each job is one goroutine, so its work never overlaps itself.
type backgroundJob struct {
	name string
	run  func(ctx context.Context)
}

// backgroundJobs is every job the server starts by itself. The ones that
// reach a third-party service are integrationStarters, which consult the
// integrations switch themselves.
func (s *Server) backgroundJobs() []backgroundJob {
	jobs := []backgroundJob{
		{"stale-sessions", s.ReconcileStaleSessions},
		{"feishu-gateway-maintenance", s.feishuGateway.Run},
		{"resource-leases", s.runResourceLeases},
		{"preview-route-check", s.runPreviewRouteCheck},
		{"session-event-compaction", s.runSessionEventCompaction},
		{"usage-request-retention", func(ctx context.Context) {
			recorder := s.hub.usageStats
			if recorder == nil {
				return
			}
			everyAfter(ctx, usagestats.RetentionSweepInterval, nil, func(ctx context.Context) {
				if _, err := recorder.DeleteExpiredRequests(ctx); err != nil && ctx.Err() == nil {
					log.Printf("usage request retention: %v", err)
				}
			})
		}},
		{"usage-history-backfill", func(ctx context.Context) {
			if s.hub.usageStats == nil {
				return
			}
			if err := s.hub.usageStats.Backfill(ctx, usagestats.BackfillOptions{}); err != nil && ctx.Err() == nil {
				log.Printf("usage history backfill: %v", err)
			}
		}},
		{"session-inbox", func(ctx context.Context) {
			everyAfter(ctx, sessions.InboxPumpInterval, s.sessionService.InboxKicks(), s.sessionService.PumpInbox)
		}},
		{"session-alerts", func(ctx context.Context) {
			everyAfter(ctx, sessionAlertPumpInterval, nil, func(ctx context.Context) {
				s.sessionAlerts.Pump(ctx, time.Now().UTC())
			})
		}},
		{"session-retries", func(ctx context.Context) {
			everyAfter(ctx, sessionRetryPumpInterval, nil, func(ctx context.Context) {
				s.sessionRetries.Pump(ctx, time.Now().UTC())
			})
		}},
		{"chat-queue-steers", func(ctx context.Context) {
			everyFromNow(ctx, chatSteerPumpInterval, nil, s.pumpChatSteers)
		}},
		// Not an integration: moves run with FOUNDRY_INTEGRATIONS=off too.
		{"workspace-migrations", s.runWorkspaceMigrations},
		{"device-removals", func(ctx context.Context) {
			everyAfter(ctx, deviceRemovalPurgeInterval, s.deviceRemovals.kicks(), s.purgeRemovedDevices)
		}},
	}
	for _, job := range s.assistant.Jobs() {
		every := everyAfter
		if job.AtStart {
			every = everyFromNow
		}
		jobs = append(jobs, backgroundJob{job.Name, func(ctx context.Context) { every(ctx, job.Interval, nil, job.Run) }})
	}
	for _, starter := range s.integrationStarters() {
		jobs = append(jobs, backgroundJob{starter.name, starter.start})
	}
	return jobs
}

// StartBackground starts every background job. stop ends them and returns
// once each has returned, so nothing still uses the store after it.
func (s *Server) StartBackground(ctx context.Context) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	var running sync.WaitGroup
	for _, job := range s.backgroundJobs() {
		running.Add(1)
		go func() {
			defer running.Done()
			job.run(ctx)
		}()
	}
	return func() {
		cancel()
		running.Wait()
	}
}

// everyFromNow runs work at once and then every interval, or sooner when
// kick fires, until ctx ends.
func everyFromNow(ctx context.Context, interval time.Duration, kick <-chan struct{}, work func(context.Context)) {
	work(ctx)
	everyAfter(ctx, interval, kick, work)
}

// everyAfter runs work every interval, or sooner when kick fires, until ctx
// ends; the first run is an interval (or a kick) away.
func everyAfter(ctx context.Context, interval time.Duration, kick <-chan struct{}, work func(context.Context)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-kick:
		}
		work(ctx)
	}
}

// workGroup runs and counts the goroutines the server starts beside requests
// and device connections, so shutdown can wait for them before the store
// closes. Unlike a sync.WaitGroup it may be waited on while work is still
// being started, and once stopped it starts nothing more.
type workGroup struct {
	// ctx ends when the group stops; work that waits or retries watches it.
	ctx    context.Context
	cancel context.CancelFunc
	// parent, when set, runs the group's work and stops it with its own.
	parent *workGroup

	mu      sync.Mutex
	stopped bool
	running int
	// idle is closed while nothing runs.
	idle chan struct{}
}

func newWorkGroup(parent *workGroup) *workGroup {
	base := context.Background()
	if parent != nil {
		base = parent.ctx
	}
	ctx, cancel := context.WithCancel(base)
	idle := make(chan struct{})
	close(idle)
	return &workGroup{ctx: ctx, cancel: cancel, parent: parent, idle: idle}
}

// Go runs work in a goroutine of its own and reports whether it started:
// once the group or its parent stopped, nothing starts.
func (g *workGroup) Go(work func()) bool {
	g.mu.Lock()
	if g.stopped {
		g.mu.Unlock()
		return false
	}
	if g.running == 0 {
		g.idle = make(chan struct{})
	}
	g.running++
	g.mu.Unlock()
	run := func() {
		defer g.finish()
		work()
	}
	if g.parent == nil {
		go run()
		return true
	}
	if g.parent.Go(run) {
		return true
	}
	g.finish()
	return false
}

func (g *workGroup) finish() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.running--
	if g.running == 0 {
		close(g.idle)
	}
}

// Wait returns once nothing the group started is running.
func (g *workGroup) Wait() {
	g.mu.Lock()
	idle := g.idle
	g.mu.Unlock()
	<-idle
}

// Stop starts nothing more, ends the group's context and waits, until ctx
// ends, for the work still running.
func (g *workGroup) Stop(ctx context.Context) error {
	g.mu.Lock()
	g.stopped = true
	idle := g.idle
	g.mu.Unlock()
	g.cancel()
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
