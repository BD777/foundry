package store

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
)

type NativeWorkRun struct {
	ID        string `json:"id"`
	StartedAt string `json:"startedAt"`
	EndedAt   string `json:"endedAt,omitempty"`
	Status    string `json:"status"`
}

type NativeWorkInfo struct {
	LastRun     *NativeWorkRun    `json:"lastRun,omitempty"`
	Runtime     string            `json:"runtime"`
	Version     string            `json:"version"`
	SessionID   string            `json:"sessionId"`
	TaskID      string            `json:"taskId"`
	Discovery   string            `json:"discovery"`
	Observation string            `json:"observation"`
	Controls    map[string]string `json:"controls"`
}

type WorkSessionReference struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	WorkspaceID string `json:"workspaceId"`
}

type SessionWork struct {
	RelatedSessions    []WorkSessionReference `json:"relatedSessions,omitempty"`
	ReferenceRevision  int64                  `json:"referenceRevision,omitempty"`
	RelatedSessionIDs  []string               `json:"relatedSessionIds,omitempty"`
	SharedSessionCount int                    `json:"sharedSessionCount,omitempty"`
	Native             *NativeWorkInfo        `json:"native,omitempty"`
	ID                 string                 `json:"id"`
	SessionID          string                 `json:"sessionId"`
	ThreadID           string                 `json:"threadId"`
	WorkspaceID        string                 `json:"workspaceId"`
	DeviceID           string                 `json:"deviceId"`
	Kind               string                 `json:"kind"`
	Source             string                 `json:"source"`
	SourceID           string                 `json:"sourceId,omitempty"`
	ParentID           string                 `json:"parentId,omitempty"`
	Title              string                 `json:"title"`
	Management         string                 `json:"management"`
	DesiredState       string                 `json:"desiredState"`
	Revision           int64                  `json:"revision"`
	Generation         int64                  `json:"generation"`
	CreatedAt          string                 `json:"createdAt"`
	UpdatedAt          string                 `json:"updatedAt"`
	Spec               WorkSpec               `json:"spec"`
	Observation        WorkObservation        `json:"observation"`
	AllowedActions     []string               `json:"allowedActions"`
}

type WorkSpec struct {
	ManualRunAt     string   `json:"manualRunAt,omitempty"`
	Schedule        string   `json:"schedule,omitempty"`
	At              string   `json:"at,omitempty"`
	TimeZone        string   `json:"timeZone,omitempty"`
	Recurring       bool     `json:"recurring,omitempty"`
	Prompt          string   `json:"prompt,omitempty"`
	Argv            []string `json:"argv,omitempty"`
	Cwd             string   `json:"cwd,omitempty"`
	NativeSessionID string   `json:"nativeSessionId,omitempty"`
	ExpiresAt       string   `json:"expiresAt,omitempty"`
	Target          string   `json:"target,omitempty"`
}

type WorkObservation struct {
	ProcessRole        string `json:"processRole,omitempty"`
	ExecutionSessionID string `json:"executionSessionId,omitempty"`
	Status             string `json:"status"`
	At                 string `json:"at"`
	ConfirmedRevision  int64  `json:"confirmedRevision"`
	NextFireAt         string `json:"nextFireAt,omitempty"`
	StartedAt          string `json:"startedAt,omitempty"`
	EndedAt            string `json:"endedAt,omitempty"`
	Error              string `json:"error,omitempty"`
	RunID              string `json:"runId,omitempty"`
	ExitCode           *int64 `json:"exitCode,omitempty"`
}

type WorkOperationItem struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}
type WorkOperation struct {
	Sequence  int64               `json:"sequence,omitempty"`
	Unmanaged int                 `json:"unmanaged,omitempty"`
	ID        string              `json:"id"`
	SessionID string              `json:"sessionId"`
	Action    string              `json:"action"`
	State     string              `json:"state"`
	CreatedAt string              `json:"createdAt"`
	Items     []WorkOperationItem `json:"items"`
}
type WorkControlInput struct {
	ExpectedReferenceRevision int64  `json:"expectedReferenceRevision,omitempty"`
	RelatedSessionID          string `json:"relatedSessionId,omitempty"`
	ID                        string `json:"id,omitempty"`
	Action                    string `json:"action"`
	ExpectedRevision          int64  `json:"expectedRevision,omitempty"`
	IdempotencyKey            string `json:"idempotencyKey"`
}
type SessionWorkScope struct {
	ID              string `json:"id"`
	ThreadID        string `json:"threadId"`
	WorkspaceID     string `json:"workspaceId"`
	DeviceID        string `json:"deviceId"`
	WorkspacePath   string `json:"workspacePath"`
	NativeSessionID string `json:"nativeSessionId,omitempty"`
}

type SessionWorkList struct {
	SweepRevision  int64              `json:"sweepRevision,omitempty"`
	ScopeIDs       []string           `json:"-"`
	Scopes         []SessionWorkScope `json:"scopes,omitempty"`
	Items          []SessionWork      `json:"items"`
	Operations     []WorkOperation    `json:"operations"`
	StoppedThreads []string           `json:"stoppedThreads,omitempty"`
	Barrier        bool               `json:"barrier"`
	Coverage       map[string]string  `json:"coverage"`
}
type WorkRun struct {
	InputID            string `json:"inputId,omitempty"`
	ExecutionSessionID string `json:"executionSessionId,omitempty"`
	ID                 string `json:"id"`
	WorkID             string `json:"workId"`
	Generation         int64  `json:"generation"`
	ScheduledAt        string `json:"scheduledAt"`
	StartedAt          string `json:"startedAt"`
	EndedAt            string `json:"endedAt,omitempty"`
	Status             string `json:"status"`
	Error              string `json:"error,omitempty"`
}

// WorkRunInputID includes generation and full slot precision via the immutable
// run identity. It is independent of transport and persistence adapters.
func WorkRunInputID(sessionID, runID string) string {
	// Name-derived UUIDv5 in the DNS namespace, accepted by native runtimes.
	h := sha1.New()
	h.Write([]byte{0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0, 0xc0, 0x4f, 0xd4, 0x30, 0xc8})
	h.Write([]byte("foundry-work-run\x00" + sessionID + "\x00" + runID))
	sum := h.Sum(nil)[:16]
	sum[6] = (sum[6] & 0x0f) | 0x50
	sum[8] = (sum[8] & 0x3f) | 0x80
	id := hex.EncodeToString(sum)
	return id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:]
}

// WorkStore keeps control intent independently of device observations and transcript retention.
type WorkStore interface {
	ListWorkspaceServices(context.Context, string) ([]SessionWork, error)
	SessionWorkSources(context.Context, string) ([]AgentSession, error)
	SaveWorkCoverage(context.Context, string, map[string]string) error
	ListSessionWork(context.Context, string, string) (SessionWorkList, error)
	SaveSessionWork(context.Context, SessionWork) (SessionWork, error)
	ObserveSessionWork(context.Context, string, WorkObservation) error
	ControlSessionWork(context.Context, string, string, WorkControlInput) (WorkOperation, error)
	ClaimWorkRun(context.Context, string, int64, string) (WorkRun, bool, error)
	FinishWorkRun(context.Context, WorkRun) error
	ListWorkRuns(context.Context, string) ([]WorkRun, error)
	WorkRunInputSession(context.Context, string) (string, error)
}

// StandaloneSessionWork excludes unclassified process scans and agent/tool infrastructure.
// Native schedules/tasks and explicit Foundry jobs have independent ownership.
func StandaloneSessionWork(item SessionWork) bool {
	return item.Source != "process" || item.Observation.ProcessRole == "background"
}
