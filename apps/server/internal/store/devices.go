package store

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

type UpsertAgentRuntimeSettingsInput struct {
	DeviceID string               `json:"deviceId,omitempty"`
	Settings AgentRuntimeSettings `json:"settings"`
}
