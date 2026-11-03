package store

// DaemonCapabilityVerificationSessions: the worker runs a verification
// session in a sandbox that keeps the workspace read-only while it runs
// commands. A worker declares it only while that sandbox (bubblewrap on
// Linux) is ready.
const DaemonCapabilityVerificationSessions = "verification_sessions"

type UpsertAgentRuntimeSettingsInput struct {
	DeviceID string               `json:"deviceId,omitempty"`
	Settings AgentRuntimeSettings `json:"settings"`
}
