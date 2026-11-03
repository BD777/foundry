package httpapi

import (
	"cmp"
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// requireVerifierDevice refuses a verifier on a device whose worker cannot
// sandbox it (on Linux, bubblewrap is missing or user namespaces are
// disabled): it would fail at launch. A device that is not connected is
// left to dispatch, which refuses it.
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
	return &statusError{http.StatusConflict, errors.New(device + " cannot run a verifier's commands in a read-only sandbox: bubblewrap is missing or user namespaces are disabled. Install bubblewrap there (sudo apt install -y bubblewrap), or start the verifier in a workspace on another device.")}
}
