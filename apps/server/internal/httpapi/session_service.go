package httpapi

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Sessions start, take messages and stop through the session service
// (internal/sessions, over the ports in session_ports.go), whoever asks.
// What stays here is who may ask and where: a caller's new session
// (resolveNewSession), and the entry points integrations (Feishu) call.

// errAssistantStartsByDispatch refuses an assistant conversation starting a
// session itself: its work goes through dispatch_item, which keeps the
// authorized item and its owner.
var errAssistantStartsByDispatch = invalid("use dispatch_item for assistant execution: preserve the authorized item, reuse its stable stepKey and existing owner; replaceOwner starts a clean context only after that owner stops")

// resolveNewSession applies, for REST (POST /api/agent-sessions) and MCP
// (create_session) alike, who may start input's session and where it runs,
// in this order:
//
//   - an assistant's conversation does not start sessions: it dispatches
//     (errAssistantStartsByDispatch);
//   - the session is its caller's person's; an agent's is created by its
//     parent's person (the store fills it in);
//   - an agent's session is its caller's child (Source "agent"), in the
//     caller's workspace unless it names another, inside the caller's Issue
//     (keepAgentInIssue), and names no native session by id, which could
//     fork one the caller cannot read;
//   - with runLikeParent, an agent's session naming no runtime or profile
//     runs like its parent when both are in the same workspace;
//   - a verifier's source is verificationSource;
//   - a fork runs in its source's workspace, on its agent (applySessionFork);
//   - the caller reaches that workspace as Member (workspaceRefusal);
//   - an agent adopts a native chat only of that workspace;
//   - with runLikeParent, a session naming no account runs under the one
//     its workspace and channel default to (chooseSessionAccount); without,
//     a person's request naming nothing is refused;
//   - it runs on an agent of that workspace (sessions.Service.ResolveDevice).
//
// A refusal is a statusError. MCP passes runLikeParent; REST does not.
func (s *Server) resolveNewSession(ctx context.Context, actor Actor, input *store.CreateAgentSessionInput, runLikeParent bool) error {
	if _, err := s.paScope(ctx, actor); err == nil {
		return errAssistantStartsByDispatch
	}
	input.CreatedByUserID = actor.AccountID()
	if actor.Agent() {
		if strings.TrimSpace(input.NativeSessionID) != "" {
			return &statusError{http.StatusBadRequest, errors.New("nativeSessionId is not accepted from a session: continue a Foundry session with its messages endpoint or fork it with forkSessionId")}
		}
		input.WorkspaceID = requestedWorkspace(actor, input.WorkspaceID)
		if err := s.keepAgentInIssue(ctx, actor, input); err != nil {
			return &statusError{http.StatusForbidden, err}
		}
		input.ParentSessionID = actor.Identity.SessionID
		input.Source = "agent"
		// Elsewhere profiles belong to another device, whose own logins may
		// not be signed in: there the session runs under an account that
		// works on that device (chooseSessionAccount).
		if runLikeParent && input.ProfileID == "" && input.Provider == "" {
			if parent, err := s.store.GetAgentSessionSummary(ctx, input.ParentSessionID); err == nil && input.WorkspaceID == parent.WorkspaceID {
				input.Provider, input.ProfileID = parent.Provider, parent.ProfileID
			}
		}
	}
	if input.Verification {
		input.Source = verificationSource
	}
	if strings.TrimSpace(input.ForkSessionID) != "" {
		if err := s.applySessionFork(ctx, input, actor); err != nil {
			return err
		}
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return err
	}
	if err := workspaceRefusal(scope, input.WorkspaceID, store.WorkspaceRoleMember); err != nil {
		return err
	}
	// A session adopts a native chat only from the workspace it starts in,
	// which it reaches as Member; an unassigned chat is in no workspace a
	// session reaches.
	if chatID := strings.TrimSpace(input.ChatID); chatID != "" && actor.Agent() {
		if chat, err := s.store.GetChat(ctx, chatID); err != nil || chat.WorkspaceID != input.WorkspaceID {
			return &statusError{http.StatusNotFound, errors.New("chat not found")}
		}
	}
	if runLikeParent {
		if err := s.chooseSessionAccount(ctx, input); err != nil {
			return err
		}
	}
	return s.sessionService.ResolveDevice(ctx, input)
}

// applySessionFork resolves forkSessionId: a new Foundry session starts from
// a copy of the source's native history, on its agent and profile, so in its
// workspace; callers check the caller may start work there. Forking needs
// ordinary read visibility into the source.
func (s *Server) applySessionFork(ctx context.Context, input *store.CreateAgentSessionInput, actor Actor) error {
	// A source the caller cannot read is not found either, so reach is not
	// disclosed.
	target, err := s.store.GetAgentSessionSummary(ctx, strings.TrimSpace(input.ForkSessionID))
	if err != nil || !s.canReadSession(ctx, actor, target) {
		return &statusError{http.StatusNotFound, fmt.Errorf("fork source session not found")}
	}
	// The store gives the fork its own native session, copied from the
	// source's; it runs on the source's agent so that copy is on its device.
	input.ForkSessionID = target.ID
	input.NativeSessionID = ""
	input.Provider = target.Provider
	input.AgentID = target.AgentID
	if input.ProfileID == "" {
		input.ProfileID = target.ProfileID
	}
	input.WorkspaceID = target.WorkspaceID
	return nil
}

// dispatchNamingJob hands a naming job to its device; one it does not take
// fails with what failed.
func (s *Server) dispatchNamingJob(ctx context.Context, job store.AgentSession) (store.AgentSession, error) {
	return s.sessionService.DispatchOrFail(ctx, job, func(err error) string { return err.Error() })
}

// CreateSessionAndDispatch starts a session for an integration (Feishu)
// whose messages name no agent: one its input does not resolve runs on the
// workspace's first connected agent, else its first.
func (s *Server) CreateSessionAndDispatch(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	if err := s.sessionService.PickDevice(ctx, &input, true); err != nil {
		return store.AgentSession{}, err
	}
	return s.sessionService.CreateAndDispatch(ctx, input, true, nil)
}

// SendSessionMessage delivers a follow-up to a session on behalf of an
// integration (Feishu) that acts with the workspace owner's authority. Its
// messages do not wait for an offline device: the chat says so at once,
// as for a new topic (CreateSessionAndDispatch).
func (s *Server) SendSessionMessage(ctx context.Context, sessionID, message string, attachments []store.ChatAttachment) error {
	if session, err := s.store.GetAgentSessionSummary(ctx, sessionID); err == nil && !s.hub.HasConnection(session.DeviceID) {
		return &statusError{http.StatusConflict, sessions.ErrLocalDaemonNotConnected}
	}
	_, err := s.sessionService.Send(ctx, sessionID, store.SendAgentSessionInput{Prompt: message, Attachments: attachments}, nil)
	return err
}

// SaveAttachments stores the files an integration (Feishu) received with
// one message in the workspace's attachments on its device, as a person's
// upload is and within the same limit.
func (s *Server) SaveAttachments(ctx context.Context, workspaceID string, files []feishu.MessageFile) ([]store.ChatAttachment, error) {
	total := 0
	for _, file := range files {
		total += len(file.Data)
	}
	if total > maxAttachmentUploadBytes {
		return nil, fmt.Errorf("the files hold more than %d MB, the most one message may bring", maxAttachmentUploadBytes>>20)
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	attachments := make([]store.ChatAttachment, 0, len(files))
	for index, file := range files {
		mimeType := file.MIMEType
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = cmp.Or(mime.TypeByExtension(strings.ToLower(filepath.Ext(sanitizeAttachmentName(file.Name)))), mimeType)
		}
		data := bytes.NewReader(file.Data)
		attachment, err := s.storeAttachment(ctx, workspace, now, index, file.Name, mimeType, int64(len(file.Data)), func(buffer []byte) (int, error) {
			return io.ReadFull(data, buffer)
		})
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}
