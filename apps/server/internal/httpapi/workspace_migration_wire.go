package httpapi

import "github.com/foundry-dev/foundry/apps/server/internal/store"

// What crosses the device link for moving a workspace to another device
// (DEV-146): the Go side of packages/protocol/src/daemon-messages.ts
// WorkspaceMigration*Payload. Every reply may carry error, the device's
// refusal.

type wsWorkspaceMigrationScanPayload struct {
	MigrationID    string               `json:"migrationId"`
	WorkspaceID    string               `json:"workspaceId"`
	Path           string               `json:"path"`
	NativeSessions []wsNativeSessionRef `json:"nativeSessions"`
}

type wsWorkspaceMigrationScannedPayload struct {
	Files          int64                                   `json:"files"`
	Bytes          int64                                   `json:"bytes"`
	ManifestDigest string                                  `json:"manifestDigest"`
	Warnings       []store.WorkspaceMigrationFolderWarning `json:"warnings"`
	Error          string                                  `json:"error,omitempty"`
}

func (p wsWorkspaceMigrationScannedPayload) refusal() error { return replyRefusal(p.Error) }

type wsWorkspaceMigrationCheckPayload struct {
	MigrationID string `json:"migrationId"`
	Path        string `json:"path"`
	Bytes       int64  `json:"bytes"`
}

type wsWorkspaceMigrationCheckedPayload struct {
	OK        bool   `json:"ok"`
	Reason    string `json:"reason,omitempty"`
	FreeBytes int64  `json:"freeBytes"`
	Path      string `json:"path"`
	Error     string `json:"error,omitempty"`
}

func (p wsWorkspaceMigrationCheckedPayload) refusal() error { return replyRefusal(p.Error) }

type wsWorkspaceMigrationTransferPayload struct {
	MigrationID    string               `json:"migrationId"`
	Role           string               `json:"role"`
	StreamID       string               `json:"streamId"`
	WorkspaceID    string               `json:"workspaceId"`
	Path           string               `json:"path"`
	NativeSessions []wsNativeSessionRef `json:"nativeSessions"`
}

type wsWorkspaceMigrationTransferStartedPayload struct {
	Error string `json:"error,omitempty"`
}

func (p wsWorkspaceMigrationTransferStartedPayload) refusal() error { return replyRefusal(p.Error) }

type wsWorkspaceMigrationProgressPayload struct {
	MigrationID    string `json:"migrationId"`
	Role           string `json:"role"`
	Phase          string `json:"phase"`
	Files          int64  `json:"files"`
	Bytes          int64  `json:"bytes"`
	TotalFiles     int64  `json:"totalFiles"`
	TotalBytes     int64  `json:"totalBytes"`
	ManifestDigest string `json:"manifestDigest,omitempty"`
	Error          string `json:"error,omitempty"`
}

type wsWorkspaceMigrationVerifyPayload struct {
	MigrationID string `json:"migrationId"`
	Path        string `json:"path"`
}

type wsWorkspaceMigrationVerifiedPayload struct {
	OK             bool     `json:"ok"`
	ManifestDigest string   `json:"manifestDigest"`
	Mismatches     []string `json:"mismatches"`
	Error          string   `json:"error,omitempty"`
}

func (p wsWorkspaceMigrationVerifiedPayload) refusal() error { return replyRefusal(p.Error) }

type wsWorkspaceMigrationRescanPayload struct {
	MigrationID    string               `json:"migrationId"`
	WorkspaceID    string               `json:"workspaceId"`
	Path           string               `json:"path"`
	NativeSessions []wsNativeSessionRef `json:"nativeSessions"`
}

type wsWorkspaceMigrationRescannedPayload struct {
	ManifestDigest string   `json:"manifestDigest"`
	Changed        bool     `json:"changed"`
	Changes        []string `json:"changes"`
	Error          string   `json:"error,omitempty"`
}

func (p wsWorkspaceMigrationRescannedPayload) refusal() error { return replyRefusal(p.Error) }

type wsWorkspaceMigrationActivatePayload struct {
	MigrationID    string               `json:"migrationId"`
	WorkspaceID    string               `json:"workspaceId"`
	Name           string               `json:"name"`
	Path           string               `json:"path"`
	PreviousPath   string               `json:"previousPath"`
	NativeSessions []wsNativeSessionRef `json:"nativeSessions"`
}

type wsWorkspaceMigrationActivatedPayload struct {
	Registration          *store.DaemonRegistration           `json:"registration,omitempty"`
	NativeSessions        *store.WorkspaceNativeSessionsMoved `json:"nativeSessions,omitempty"`
	ExecutionRoot         string                              `json:"executionRoot,omitempty"`
	PreviousExecutionRoot string                              `json:"previousExecutionRoot,omitempty"`
	Error                 string                              `json:"error,omitempty"`
}

func (p wsWorkspaceMigrationActivatedPayload) refusal() error { return replyRefusal(p.Error) }

type wsWorkspaceMigrationRetirePayload struct {
	MigrationID    string `json:"migrationId"`
	WorkspaceID    string `json:"workspaceId"`
	TargetDeviceID string `json:"targetDeviceId"`
}

type wsWorkspaceMigrationAbortPayload struct {
	MigrationID string `json:"migrationId"`
	Path        string `json:"path"`
}

type wsWorkspaceMigrationPurgePayload struct {
	MigrationID    string `json:"migrationId"`
	WorkspaceID    string `json:"workspaceId"`
	Confirm        bool   `json:"confirm"`
	IncludeChanged bool   `json:"includeChanged,omitempty"`
}

type wsWorkspaceMigrationPurgedPayload struct {
	Removed []string `json:"removed"`
	Changed []string `json:"changed"`
	Bytes   int64    `json:"bytes"`
	Done    bool     `json:"done"`
	Error   string   `json:"error,omitempty"`
}

func (p wsWorkspaceMigrationPurgedPayload) refusal() error { return replyRefusal(p.Error) }
