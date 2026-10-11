package httpapi

import (
	"cmp"
	"context"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// verificationSource marks an independent verifier: a session that reads
// the workspace and runs commands that only read, in a sandbox its worker
// keeps the workspace read-only in (worker: verification-session.ts). Its
// Foundry tools are the ones that change nothing (mcpToolAvailability).
const verificationSource = "verification"

// requireVerifierDevice refuses a verifier on a device whose worker
// predates sandboxed verifiers: that worker would run it without commands,
// not as create_session describes. A device that is not connected is left
// to dispatch, which refuses it.
func (s *Server) requireVerifierDevice(ctx context.Context, input store.CreateAgentSessionInput) error {
	if !input.Verification {
		return nil
	}
	workspace, err := s.store.GetWorkspace(ctx, input.WorkspaceID)
	if err != nil {
		return err
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil || connection.hasCapability(store.DaemonCapabilityVerificationSessions) {
		return nil
	}
	device := cmp.Or(strings.TrimSpace(workspace.DeviceLabel), "The workspace's device")
	return &mcpToolError{http.StatusConflict, device + " runs an older worker, which cannot run a verifier's commands in a read-only sandbox. Update its worker from its device page in Foundry, or start the verifier in a workspace on another device."}
}
