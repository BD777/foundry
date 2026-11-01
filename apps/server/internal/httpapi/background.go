package httpapi

import (
	"context"
	"sync"
	"time"
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
			everyAfter(ctx, inboxPumpInterval, s.inbox.kicks(), s.pumpSessionInbox)
		}},
		{"chat-queue-steers", func(ctx context.Context) {
			everyFromNow(ctx, chatSteerPumpInterval, nil, s.pumpChatSteers)
		}},
		{"personal-agent-inbox", func(ctx context.Context) {
			everyFromNow(ctx, 2*time.Second, nil, s.drainPersonalAgentInbox)
		}},
		{"personal-agent-operations", func(ctx context.Context) {
			everyFromNow(ctx, 2*time.Second, nil, s.drainPersonalAgentOperations)
		}},
		{"personal-agent-run-controls", func(ctx context.Context) {
			everyFromNow(ctx, 5*time.Second, nil, s.drainAssistantRunControls)
		}},
		{"personal-agent-maintenance", func(ctx context.Context) {
			everyFromNow(ctx, 30*time.Second, nil, s.drainPersonalAgentMaintenance)
		}},
		{"personal-agent-supervision", func(ctx context.Context) {
			everyAfter(ctx, supervisionInterval, nil, s.superviseAssistantTasksNow)
		}},
		{"personal-agent-reminders", func(ctx context.Context) {
			everyAfter(ctx, reminderInterval, nil, s.sendDueAssistantReminders)
		}},
		{"knowledge-operations", func(ctx context.Context) {
			everyFromNow(ctx, 3*time.Second, nil, s.drainKnowledgeOperations)
		}},
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
