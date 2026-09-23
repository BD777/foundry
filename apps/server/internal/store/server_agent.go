package store

import "strings"

// ServerAgentID builds the stable id of the agent projection a server-owned
// profile takes for one workspace on its owning device. It is the single
// construction site for that identity: the snapshot projection, the chat
// picker and the session-create resolver must all derive the same string
// from trusted server-side records, never from client-supplied fields.
func ServerAgentID(deviceID string, workspaceID string, profileID string) string {
	return "agent_" +
		safeAgentIDPart(deviceID) + "_" +
		safeAgentIDPart(workspaceID) + "_" +
		safeAgentIDPart(profileID)
}

// safeAgentIDPart mirrors the daemon's agent id shape so server-owned and
// device-owned agents sort and key identically.
func safeAgentIDPart(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for _, character := range strings.ToLower(value) {
		switch {
		case character >= 'a' && character <= 'z', character >= '0' && character <= '9':
			builder.WriteRune(character)
		default:
			builder.WriteByte('_')
		}
	}
	return builder.String()
}
