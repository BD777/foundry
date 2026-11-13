package store

import "context"

// DaemonCapabilityVerificationSessions: the worker runs a verification
// session in a sandbox that keeps the workspace read-only while it runs
// commands. A worker declares it only while that sandbox (bubblewrap on
// Linux) is ready.
const DaemonCapabilityVerificationSessions = "verification_sessions"

// DaemonCapabilityNativeSignIn: the worker signs Claude Code or Codex in to
// its subscription through the CLI on the device (native_sign_in).
const DaemonCapabilityNativeSignIn = "native_sign_in"

// DaemonCapabilityProfileCheck: the worker checks a server profile it is
// handed with one short conversation through the agent's own SDK
// (check_agent_profile).
const DaemonCapabilityProfileCheck = "profile_check"

// DaemonCapabilityDispatchRetry: the worker gives every automatic model retry
// a fresh dispatch identity, so the same logical input can run again without
// its durable completion marker suppressing the retry.
const DaemonCapabilityDispatchRetry = "dispatch_retry"

// DaemonCapabilityReadOnlyWorkspaceSessions: the worker runs a session whose
// workspaceAccess is read inside the same sandbox as a verifier, keeping its
// workspace read-only (DEV-203 message channel sessions). Declared only while
// that sandbox is ready.
const DaemonCapabilityReadOnlyWorkspaceSessions = "read_only_workspace_sessions"

// DaemonCapabilityWorkspaceFileWrite: the worker writes one text file in a
// workspace on the server's request (write_file).
const DaemonCapabilityWorkspaceFileWrite = "workspace_file_write"

// DaemonCapabilitySharedLeases: the worker runs shared leases of one
// resource side by side (a provider session per lease, resetLeaseOnly
// resets, operate requests marked shared). Without it the server gives
// the device's resources one lease at a time.
const DaemonCapabilitySharedLeases = "shared_leases"

type UpsertAgentRuntimeSettingsInput struct {
	DeviceID string               `json:"deviceId,omitempty"`
	Settings AgentRuntimeSettings `json:"settings"`
}

// DeviceRuntimeStateStore keeps the latest admission sample a worker
// reported. The server stores it as-is; it does not calculate resource
// limits.
type DeviceRuntimeStateStore interface {
	SaveDeviceRuntimeState(ctx context.Context, deviceID string, state DeviceRuntimeState) error
}
