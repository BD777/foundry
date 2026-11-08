package store

import (
	"context"
	"errors"
)

// Moving a workspace to another device (DEV-146,
// docs/devlog/DEV-146-workspace-migration.md). The server drives the move as
// a durable job; WorkspaceMigration is what people see of it.

const (
	WorkspaceMigrationPreflight  = "preflight"
	WorkspaceMigrationCopying    = "copying"
	WorkspaceMigrationVerifying  = "verifying"
	WorkspaceMigrationActivating = "activating"
	WorkspaceMigrationRetiring   = "retiring"
	WorkspaceMigrationComplete   = "complete"
	WorkspaceMigrationCanceled   = "canceled"
	WorkspaceMigrationFailed     = "failed"
)

// WorkspaceMigrationFrozen reports a state in which the workspace takes no
// new work: its files are being copied, checked or switched over.
func WorkspaceMigrationFrozen(state string) bool {
	return state == WorkspaceMigrationCopying || state == WorkspaceMigrationVerifying || state == WorkspaceMigrationActivating
}

// WorkspaceMigrationEnded reports a state the job never leaves.
func WorkspaceMigrationEnded(state string) bool {
	return state == WorkspaceMigrationComplete || state == WorkspaceMigrationCanceled || state == WorkspaceMigrationFailed
}

var (
	// ErrWorkspaceMigrationActive refuses a second move of a workspace, or
	// changing a workspace (delete, relink, archive) while it moves.
	ErrWorkspaceMigrationActive = errors.New("the workspace is moving to another device")
	// ErrWorkspaceMigrationRevision: the job changed since it was read.
	ErrWorkspaceMigrationRevision = errors.New("the workspace move changed meanwhile")
	// ErrWorkspaceMigrationNotCancelable: the switch to the target began.
	ErrWorkspaceMigrationNotCancelable = errors.New("the workspace already switched to the new device; the move can no longer be canceled")
)

// WorkspaceMigrationRecord is the stored job: the public view and what the
// driver keeps between its steps.
type WorkspaceMigrationRecord struct {
	WorkspaceMigration
	Revision int64 `json:"revision"`
	// LeaseUntil: no driver takes the job before then ("" any time).
	LeaseUntil  string `json:"-"`
	ActorUserID string `json:"actorUserId,omitempty"`
	// ManifestDigest is the source scan's manifest digest; the target's
	// staging and verification must match it.
	ManifestDigest string `json:"manifestDigest,omitempty"`
	// ReceivedDigest is what the target reported holding when it received.
	ReceivedDigest string `json:"receivedDigest,omitempty"`
	// Attempts counts transfers started; FailedAttempts the ones in a row
	// that ended without moving a byte more.
	Attempts       int `json:"attempts,omitempty"`
	FailedAttempts int `json:"failedAttempts,omitempty"`
	// VerifyMismatches counts verifications that did not match.
	VerifyMismatches int `json:"verifyMismatches,omitempty"`
	// ExecutionRoot and PreviousExecutionRoot are what the target's
	// activation answered.
	ExecutionRoot         string `json:"executionRoot,omitempty"`
	PreviousExecutionRoot string `json:"previousExecutionRoot,omitempty"`
}

// WorkspaceMigrationActivation is what the target device answered when it
// took the workspace over; ActivateWorkspaceMigration rewrites the rows by it.
type WorkspaceMigrationActivation struct {
	// TargetPath is the folder on the target (the registration's localPath).
	TargetPath            string
	ExecutionRoot         string
	PreviousExecutionRoot string
	TargetDeviceLabel     string
}

// WorkspaceMigrationStore keeps the jobs (sqlitestore/workspace_migrations.go).
type WorkspaceMigrationStore interface {
	// CreateWorkspaceMigration stores a new job in preflight; another one
	// under way is ErrWorkspaceMigrationActive.
	CreateWorkspaceMigration(ctx context.Context, record WorkspaceMigrationRecord) (WorkspaceMigrationRecord, error)
	GetWorkspaceMigration(ctx context.Context, workspaceID, id string) (WorkspaceMigrationRecord, error)
	// CurrentWorkspaceMigration is the workspace's latest job.
	CurrentWorkspaceMigration(ctx context.Context, workspaceID string) (WorkspaceMigrationRecord, error)
	// DueWorkspaceMigrations lists jobs under way whose lease ran out.
	DueWorkspaceMigrations(ctx context.Context, now string) ([]WorkspaceMigrationRecord, error)
	// SaveWorkspaceMigration writes record if its revision is current and
	// its state change is allowed, and returns it with the next revision.
	SaveWorkspaceMigration(ctx context.Context, record WorkspaceMigrationRecord) (WorkspaceMigrationRecord, error)
	// RenewWorkspaceMigrationLease moves the lease of a job a driver runs,
	// leaving its revision; it returns the job as stored.
	RenewWorkspaceMigrationLease(ctx context.Context, id, until string) (WorkspaceMigrationRecord, error)
	RequestWorkspaceMigrationCancel(ctx context.Context, workspaceID, id string) (WorkspaceMigrationRecord, error)
	// ActivateWorkspaceMigration moves, in one transaction, every row that
	// names the source device or folder to the target and the job to
	// retiring.
	ActivateWorkspaceMigration(ctx context.Context, record WorkspaceMigrationRecord, activation WorkspaceMigrationActivation) (WorkspaceMigrationRecord, error)
	// WorkspaceMigrationBlockers is the work that must end first.
	WorkspaceMigrationBlockers(ctx context.Context, workspaceID string) ([]WorkspaceMigrationBlocker, error)
	// WorkspaceMigrationNotCarried is what stays tied to the source device.
	WorkspaceMigrationNotCarried(ctx context.Context, workspaceID, sourceDeviceID, targetDeviceID string) ([]WorkspaceMigrationNotCarried, error)
}
