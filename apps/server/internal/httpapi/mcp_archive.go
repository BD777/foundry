package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type mcpArchiveSpec struct {
	WorkspaceID     string   `json:"workspaceId"`
	SessionID       string   `json:"sessionId,omitempty"`
	SessionIDs      []string `json:"sessionIds,omitempty"`
	GroupID         string   `json:"groupId,omitempty"`
	Restore         bool     `json:"restore,omitempty"`
	ExpectedChatIDs []string `json:"expectedChatIds,omitempty"`
}

func (s *Server) archiveSpec(ctx context.Context, actor Actor, workspace string, args map[string]json.RawMessage) (mcpArchiveSpec, store.ArchiveChatsInput, error) {
	spec := mcpArchiveSpec{WorkspaceID: workspace, SessionID: mcpArgString(args, "sessionId"), SessionIDs: mcpArgList(args, "sessionIds"), GroupID: mcpArgString(args, "groupId"), Restore: mcpArgBool(args, "restore"), ExpectedChatIDs: mcpArgList(args, "expectedChatIds")}
	ids := spec.SessionIDs
	if spec.SessionID != "" {
		if len(ids) > 0 {
			return spec, store.ArchiveChatsInput{}, store.ErrInvalidArchive
		}
		ids = []string{spec.SessionID}
	}
	resolved := []string{}
	for _, raw := range ids {
		session, err := s.controlledSession(ctx, actor, raw, "archive")
		if err != nil {
			return spec, store.ArchiveChatsInput{}, err
		}
		if len(resolved) == 0 && spec.GroupID == "" {
			spec.WorkspaceID = session.WorkspaceID
		}
		if session.WorkspaceID != spec.WorkspaceID {
			return spec, store.ArchiveChatsInput{}, store.ErrInvalidArchive
		}
		resolved = append(resolved, session.ID)
	}
	input := store.ArchiveChatsInput{WorkspaceID: spec.WorkspaceID, ChatIDs: resolved, GroupID: spec.GroupID, ExpectedChatIDs: spec.ExpectedChatIDs}
	_, err := s.authorizeArchive(ctx, actor, input)
	return spec, input, err
}
func (s *Server) archiveSessionForMCP(call mcpCall) (string, error) {
	if _, err := s.paScope(call.r.Context(), call.actor); err == nil {
		return s.assistantWrite(call, "archive_session", (*Server).planArchiveSession)
	}
	spec, input, err := s.archiveSpec(call.r.Context(), call.actor, call.workspace, call.args)
	if err != nil {
		return "", err
	}
	result, err := s.archiveChats(call.r.Context(), call.actor, input, spec.Restore)
	if errors.Is(err, store.ErrArchiveBlocked) {
		return "", &statusError{http.StatusConflict, fmt.Errorf("%w: %v", err, result.Blockers)}
	}
	if err != nil {
		return "", err
	}
	return encodeJSON(result)
}
func (s *Server) planArchiveSession(ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error) {
	actor := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: scope.sessionID, WorkspaceID: scope.agent.WorkspaceID, AccountID: scope.agent.UserID}}
	// A web/Feishu confirmation arrives with its person's cached request scope.
	// Re-evaluate and bind the assistant's scope before acting as that assistant;
	// otherwise a human scope's empty agentFor would refuse its own proposal.
	fresh, scopeErr := s.scopeFor(ctx, actor)
	if scopeErr != nil {
		return paWrite{}, scopeErr
	}
	ctx = contextWithScope(actorInContext(ctx, actor), fresh)

	spec, input, err := s.archiveSpec(ctx, actor, requestedWorkspace(actor, mcpArgString(args, "workspaceId")), args)
	write := paWrite{workspaceID: spec.WorkspaceID, argsSummary: "archive sessions", spec: spec}
	if err != nil {
		return write, err
	}
	st, _ := s.archiveStore()
	ids, err := st.ArchiveChatIDs(ctx, input)
	if err != nil {
		return write, err
	}
	// Freeze the confirmed set: a folder edited while a card is pending must
	// be reviewed again instead of silently adding newly placed conversations.
	if spec.ExpectedChatIDs != nil && !slices.Equal(spec.ExpectedChatIDs, ids) {
		return write, &statusError{http.StatusConflict, store.ErrChatLayoutConflict}
	}
	spec.ExpectedChatIDs = ids
	input.ExpectedChatIDs = ids
	write.spec = spec
	decision := personalagent.Decide(scope.agent.Settings.Policy, store.PersonalAgentActionArchiveSession)
	if decision != store.PersonalAgentDeny && (spec.GroupID != "" || len(ids) > 3) {
		decision = store.PersonalAgentAsk
	}

	write.subject = fmt.Sprintf("%d chats", len(ids))
	write.decisions = []paDecision{{action: store.PersonalAgentActionArchiveSession, decision: decision}}
	write.apply = func(ctx context.Context) (any, error) {
		return s.archiveChats(contextWithScope(actorInContext(ctx, actor), fresh), actor, input, spec.Restore)
	}
	return write, nil
}
