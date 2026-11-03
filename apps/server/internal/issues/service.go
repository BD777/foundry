package issues

import (
	"context"
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/keylock"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what the service keeps of Issues: the Issues, their evidence
// (contracts, clarification) and their executions.
type Store interface {
	store.Store
	store.EvidenceStore
	store.IssueExecutionStore
}

// Devices is the server's link to the devices Issues run on; httpapi's
// device hub implements it.
type Devices interface {
	// Connected reports whether the device is connected.
	Connected(deviceID string) bool
	// Git makes sure the workspace's folder has Git with a commit for an
	// Issue, setting it up when initialize allows (initialized). A folder
	// without it whose person has not agreed is a NeedsGit.
	Git(ctx context.Context, workspaceID string, initialize bool) (initialized bool, err error)
	// CheckRetry asks the Issue's device whether its candidate may change
	// again; the device stops the candidate's previews on the way.
	CheckRetry(ctx context.Context, issue store.Issue) error
	// Dispatch hands a session's queued input to its device.
	Dispatch(session store.AgentSession) error
	// ClaimReady has connected devices claim the Issues that may run.
	ClaimReady()
}

// NeedsGit refuses an Issue in a workspace without Git (or without commits)
// whose person has not agreed to set it up; Path is its folder.
type NeedsGit struct{ Path string }

func (e *NeedsGit) Error() string { return "this workspace needs Git first; confirm to initialize" }

// Actor is who acts on an Issue: the actor its records name, the account
// (UserID, "" for the local owner), where a person's message came from when
// not the web (Via, "feishu"), and, for Message, the account's role in the
// Issue's workspace (Role).
type Actor struct {
	store.ActorRef
	UserID string
	Via    string
	Role   string
}

// Service is an Issue's lifecycle. Whoever asks (REST, the Feishu desk, a
// session token) goes through it. Its signatures carry no HTTP; a refusal
// is a sessions.Refusal.
type Service struct {
	store   Store
	events  Notifier
	devices Devices
	locks   keylock.Locks
}

// New is the service over st, telling events what happens to Issues.
func New(st Store, events Notifier, devices Devices) *Service {
	return &Service{store: st, events: events, devices: devices}
}

// Lock serializes what changes one Issue, by its canonical id, or anything
// else keyed by key; the returned func unlocks it.
func (s *Service) Lock(key string) func() {
	return s.locks.Lock(key)
}

// locked is the Issue issueID (its id or short id) read under its lock.
func (s *Service) locked(ctx context.Context, issueID string) (store.Issue, func(), error) {
	issue, err := s.store.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, nil, err
	}
	unlock := s.Lock(issue.ID)
	if issue, err = s.store.GetIssue(ctx, issue.ID); err != nil {
		unlock()
		return store.Issue{}, nil, err
	}
	return issue, unlock, nil
}

// DecisionRole is the workspace role deciding for the Issue takes
// (confirming its criteria, answering its questions, verifying and
// assessing): its creator decides as a member, anyone else as a maintainer.
func DecisionRole(issue store.Issue, userID string) string {
	if userID != "" && userID == issue.CreatedByUserID {
		return store.WorkspaceRoleMember
	}
	return store.WorkspaceRoleMaintainer
}

// MayDecide reports whether the account, with role in the Issue's
// workspace, may decide for it.
func MayDecide(issue store.Issue, userID, role string) bool {
	return store.WorkspaceRoleAtLeast(role, DecisionRole(issue, userID))
}

// refused is what the store refused as the request's refusal, with
// status, unless the error says why itself: a missing record, a removed
// device, a key replayed with other input, a busy database.
func refused(status int, err error) error {
	if err == nil || errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrDeviceRemoved) ||
		errors.Is(err, store.ErrIdempotencyConflict) || store.IsBusy(err) {
		return err
	}
	var refusal *sessions.Refusal
	if errors.As(err, &refusal) {
		return err
	}
	return &sessions.Refusal{Status: status, Err: err}
}

func conflict(err error) error { return refused(http.StatusConflict, err) }
