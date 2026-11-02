package httpapi

import (
	"context"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
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
		{"session-inbox", func(ctx context.Context) {
			everyAfter(ctx, sessions.InboxPumpInterval, s.sessionService.InboxKicks(), s.sessionService.PumpInbox)
		}},
		{"chat-queue-steers", func(ctx context.Context) {
			everyFromNow(ctx, chatSteerPumpInterval, nil, s.pumpChatSteers)
		}},
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
