package httpapi

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
)

type wsKnowledgeReply struct{ store.KnowledgeReply }

func (p wsKnowledgeReply) refusal() error {
	if p.Error != "" {
		reason := fmt.Errorf("%s: %s", p.Code, p.Error)
		switch p.Code {
		case "external_edit", "revision_conflict", "idempotency_conflict", "fenced", "locked", "root_conflict":
			return &statusError{http.StatusConflict, reason}
		case "not_found":
			return &statusError{http.StatusNotFound, reason}
		case "unsafe_path", "invalid_path", "invalid_id", "invalid_expiry", "too_large", "too_many":
			return &statusError{http.StatusBadRequest, reason}
		default:
			return reason
		}
	}
	return nil
}
func (h *DaemonHub) knowledgeCommand(ctx context.Context, workspace store.WorkspaceProjection, command store.KnowledgeCommand) (store.KnowledgeReply, error) {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return store.KnowledgeReply{}, &statusError{http.StatusServiceUnavailable, fmt.Errorf("memory_device_offline")}
	}
	if !connection.hasCapability("knowledge_files_v1") {
		return store.KnowledgeReply{}, &statusError{http.StatusServiceUnavailable, fmt.Errorf("memory_worker_update_required")}
	}
	if command.WorkspaceID != workspace.ID {
		return store.KnowledgeReply{}, fmt.Errorf("knowledge workspace mismatch")
	}
	result, err := callDevice[wsKnowledgeReply](ctx, connection, wsKnowledgeCommandType, command)
	return result.KnowledgeReply, err
}
