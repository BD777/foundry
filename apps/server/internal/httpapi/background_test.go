package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
)

// Every background job ends with the server: stop returns only once each
// one has returned, so none still works on the store after it closes.
func TestStopBackgroundWaitsForEveryJob(t *testing.T) {
	server := NewServerWithOptions(newTestStore(t), ServerOptions{Integrations: integrations.New(false)})
	if len(server.backgroundJobs()) < len(server.integrationStarters())+10 {
		t.Fatalf("background jobs = %d", len(server.backgroundJobs()))
	}
	stop := server.StartBackground(context.Background())
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("a background job outlived stop")
	}
}

// everyAfter runs its work on a kick before the interval is up, and not
// before either.
func TestEveryAfterRunsOnKick(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	kick := make(chan struct{})
	ran := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		everyAfter(ctx, time.Hour, kick, func(context.Context) { ran <- struct{}{} })
		close(done)
	}()
	select {
	case <-ran:
		t.Fatal("ran before its interval or a kick")
	case <-time.After(50 * time.Millisecond):
	}
	kick <- struct{}{}
	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		t.Fatal("a kick did not run the work")
	}
	cancel()
	<-done
}
