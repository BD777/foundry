// Package upkeep runs Foundry's scheduled model reviews: project summaries
// (workspacedigest), project governance and memory review (pa_maintenance).
// The loops keep their own durable rows and answer formats; what they share
// is here: whose home the session runs on, whether the machine the review
// reads is reachable, the pinned run, the dispatch and the deferral.
//
// A global review (summaries, governance, the person's memory layer) belongs
// to the person and runs on their default assistant's home, whether or not
// that assistant's conversation is stopped: upkeep is Foundry's maintenance,
// not the assistant's action. A per-assistant review (that assistant's own
// memory layer) runs on that assistant's home. A review that must read a
// workspace on another machine is deferred alone while that machine is away;
// it never makes the other reviews wait.
package upkeep

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	// TargetOfflineDelay is when a review that reads a workspace on an
	// offline machine is looked at again.
	TargetOfflineDelay = time.Minute
	// RunUnavailableDelay is when a review whose account or permission is
	// not usable now is looked at again.
	RunUnavailableDelay = 5 * time.Minute
	// AccountUnavailableDelay is when a review with no usable account on its
	// machine is looked at again.
	AccountUnavailableDelay = 5 * time.Minute
	// AcceptanceFailedDelay is when a review whose session could not be
	// started is looked at again.
	AcceptanceFailedDelay = time.Minute
)

// ErrDeferred is what Start returns after it recorded why a review cannot
// run now. Callers treat it as "looked at, postponed", not as a failure.
var ErrDeferred = errors.New("upkeep deferred")

// DeferError is an adapter's reason to postpone a claimed start (the
// maintenance loops' concurrency and daily model budget, for example).
type DeferError struct {
	Reason string
	Delay  time.Duration
}

func (e *DeferError) Error() string { return e.Reason }

// Defer records why a review is postponed and when it is looked at again.
// Both loops already have such a transition (a digest's postponement, a
// maintenance job's waiting status).
type Defer func(ctx context.Context, reason string, delay time.Duration) error

// Resolver pins the account, model and budget of a review's run.
type Resolver interface {
	Pin(ctx context.Context, agent store.PersonalAgent, operationID, role, workspaceID string) (store.PersonalAgentRunSnapshot, error)
	CheckPinned(ctx context.Context, snapshot store.PersonalAgentRunSnapshot) error
}

// Sessions starts the review's session on its machine.
type Sessions interface {
	PickDevice(ctx context.Context, input *store.CreateAgentSessionInput, anyAgent bool) error
	CreateAndDispatch(ctx context.Context, input store.CreateAgentSessionInput, opts sessions.StartOptions) (store.AgentSession, error)
}

// Runner starts one review. Connected answers whether a machine is online;
// it is the server's own view (hub), the same one placement and the loops
// use.
type Runner struct {
	Runs      Resolver
	Sessions  Sessions
	Connected func(deviceID string) bool
}

// Request is one review to start.
type Request struct {
	// OperationID names the run; it makes pinning and dispatch idempotent.
	OperationID string
	// Role is the run role (digest, governance or memory).
	Role string
	// Agent owns the run: its settings, account and home workspace.
	Agent store.PersonalAgent
	// WorkspaceID is where the review session runs. Global reviews use the
	// default assistant's home workspace; a per-assistant memory review uses
	// its vault's workspace.
	WorkspaceID string
	// TargetDevice is the machine whose workspace the review reads, or "".
	// When it is away this review alone is deferred.
	TargetDevice string
	// Prompt is what the review session starts with.
	Prompt string
	// Configure sets the session's source, read-only sandbox and similar
	// (run.SessionInput has already filled the account and model).
	Configure func(*store.CreateAgentSessionInput)
	// Resume continues a session a restart left behind (the digest loop).
	Resume bool
	// Claim runs once the run is pinned and before a session exists: the
	// maintenance loops' concurrency and daily model budget. A DeferError
	// postpones the job without creating a session that would only fail.
	Claim func(ctx context.Context, snapshot store.PersonalAgentRunSnapshot) error
	// BeforeDispatch records the claim once the session exists, before the
	// machine receives it. A false claim (another run started first) is
	// answered by returning an error.
	BeforeDispatch func(ctx context.Context, snapshot store.PersonalAgentRunSnapshot, session store.AgentSession) error
	// Abort releases a claim when the session could not be handed to its
	// machine, so the review is looked at again instead of staying claimed
	// by a session that never ran.
	Abort func(ctx context.Context, session store.AgentSession)
	// Defer records why this review waits. Nil means the caller does not
	// track deferral (tests).
	Defer Defer
}

// Outcome is a started review, or a session that already existed and was
// claimed by another dispatcher.
type Outcome struct {
	Session  store.AgentSession
	Snapshot store.PersonalAgentRunSnapshot
	Existing bool
}

// Start pins and dispatches one review. It returns ErrDeferred after Defer
// recorded a postponement, ErrSessionInputExists-shaped outcomes as
// Existing, and any other error unchanged.
func (r *Runner) Start(ctx context.Context, req Request) (Outcome, error) {
	deferNow := func(reason string, delay time.Duration) (Outcome, error) {
		if req.Defer == nil {
			return Outcome{}, ErrDeferred
		}
		if err := req.Defer(ctx, reason, delay); err != nil {
			return Outcome{}, err
		}
		return Outcome{}, ErrDeferred
	}
	if req.TargetDevice != "" && r.Connected != nil && !r.Connected(req.TargetDevice) {
		return deferNow("target_device_offline", TargetOfflineDelay)
	}
	snapshot, err := r.Runs.Pin(ctx, req.Agent, req.OperationID, req.Role, req.WorkspaceID)
	if err != nil {
		return deferNow("role_configuration_unavailable", RunUnavailableDelay)
	}
	if err := r.Runs.CheckPinned(ctx, snapshot); err != nil {
		return deferNow("role_configuration_changed", RunUnavailableDelay)
	}
	if req.Claim != nil {
		var deferred *DeferError
		if err := req.Claim(ctx, snapshot); errors.As(err, &deferred) {
			return deferNow(deferred.Reason, deferred.Delay)
		} else if err != nil {
			return deferNow("input_acceptance_failed", AcceptanceFailedDelay)
		}
	}
	input := run.SessionInput(snapshot, req.Prompt, snapshot.InputID)
	if req.Configure != nil {
		req.Configure(&input)
	}
	if err := r.Sessions.PickDevice(ctx, &input, true); err != nil {
		return deferNow("account_unavailable", AccountUnavailableDelay)
	}
	session, err := r.Sessions.CreateAndDispatch(ctx, input, sessions.StartOptions{
		FailOffline: true, Resume: req.Resume,
		BeforeDispatch: func(ctx context.Context, session store.AgentSession) error {
			if req.BeforeDispatch == nil {
				return nil
			}
			return req.BeforeDispatch(ctx, snapshot, session)
		},
	})
	var deferred *DeferError
	switch {
	case errors.Is(err, store.ErrSessionInputExists):
		return Outcome{Snapshot: snapshot, Existing: true}, nil
	case errors.As(err, &deferred):
		return deferNow(deferred.Reason, deferred.Delay)
	case err != nil:
		if req.Abort != nil && session.ID != "" {
			req.Abort(ctx, session)
		}
		if errors.Is(err, sessions.ErrLocalDaemonNotConnected) {
			return deferNow("device_offline", time.Minute)
		}
		log.Printf("upkeep %s: start failed: %v", req.Role, err)
		return deferNow("input_acceptance_failed", AcceptanceFailedDelay)
	case session.ID == "":
		return deferNow("input_acceptance_failed", AcceptanceFailedDelay)
	}
	return Outcome{Session: session, Snapshot: snapshot}, nil
}

// Owner is the assistant a global review belongs to: the person's default
// assistant, whether or not its conversation is stopped.
func Owner(ctx context.Context, st interface {
	DefaultAssistant(context.Context, string) (store.PersonalAgent, error)
}, userID string) (store.PersonalAgent, error) {
	return st.DefaultAssistant(ctx, userID)
}
