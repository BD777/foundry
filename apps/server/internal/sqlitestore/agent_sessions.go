package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) ListAgentSessions(ctx context.Context, workspaceID string) ([]store.AgentSession, error) {
	sessions, err := s.listAgentSessions(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for index := range sessions {
		if err := s.attachAgentSessionEvents(ctx, &sessions[index]); err != nil {
			return nil, err
		}
	}
	return sessions, nil
}

func (s *Store) ListAgentSessionSummaries(ctx context.Context, workspaceID string) ([]store.AgentSession, error) {
	sessions, err := s.listAgentSessions(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for index := range sessions {
		sessions[index].ImportedContext = ""
		sessions[index].ProfileTransitionNote = ""
		sessions[index].Response = ""
		sessions[index].Error = ""
		sessions[index].Events = nil
	}
	return sessions, nil
}

// ListAgentSessionThread returns one complete, ordered transcript snapshot.
// The id may identify either the thread itself or any session within it.
func (s *Store) ListAgentSessionThread(ctx context.Context, workspaceID string, id string) ([]store.AgentSession, error) {
	id = strings.TrimSpace(id)
	workspaceID = strings.TrimSpace(workspaceID)
	if id == "" {
		return nil, errors.New("agent session thread id is required")
	}

	query := `SELECT workspace_id, thread_id FROM agent_sessions WHERE (id = ? OR thread_id = ?) AND ` + visibleAgentSessionSQL
	args := []any{id, id}
	if workspaceID != "" {
		query += ` AND workspace_id = ?`
		args = append(args, workspaceID)
	}
	query += ` ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC LIMIT 1`
	args = append(args, id)

	var resolvedWorkspaceID string
	var resolvedThreadID string
	if err := s.conn().QueryRowContext(ctx, query, args...).Scan(&resolvedWorkspaceID, &resolvedThreadID); err != nil {
		return nil, err
	}

	sessions, err := listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events'), '$.lastActivityAt', updated_at)
		FROM agent_sessions
		WHERE workspace_id = ? AND thread_id = ?
		ORDER BY created_at ASC, id ASC`, resolvedWorkspaceID, resolvedThreadID)
	if err != nil {
		return nil, err
	}
	if err := s.attachAgentSessionThreadEvents(ctx, sessions, resolvedWorkspaceID, resolvedThreadID); err != nil {
		return nil, err
	}
	return sessions, nil
}

func (s *Store) attachAgentSessionThreadEvents(ctx context.Context, sessions []store.AgentSession, workspaceID string, threadID string) error {
	events, err := listJSON[store.AgentSessionEvent](ctx, s.conn(), `SELECT event.payload_json
		FROM agent_session_events AS event
		JOIN agent_sessions AS session ON session.id = event.session_id
		WHERE session.workspace_id = ? AND session.thread_id = ?
		ORDER BY event.created_at ASC`, workspaceID, threadID)
	if err != nil {
		return err
	}
	sessionIndexes := make(map[string]int, len(sessions))
	for index := range sessions {
		sessions[index].Events = []store.AgentSessionEvent{}
		sessionIndexes[sessions[index].ID] = index
	}
	for _, event := range events {
		index, ok := sessionIndexes[event.SessionID]
		if !ok {
			continue
		}
		sessions[index].Events = append(sessions[index].Events, event)
	}
	return nil
}

func (s *Store) listAgentSessions(ctx context.Context, workspaceID string) ([]store.AgentSession, error) {
	var sessions []store.AgentSession
	var err error
	if workspaceID != "" {
		sessions, err = listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE workspace_id = ? AND (COALESCE(json_extract(payload_json, '$.source'), '') <> 'naming' OR status IN ('queued','running')) AND `+visibleAgentSessionSQL+` ORDER BY updated_at DESC LIMIT 80`, workspaceID)
	} else {
		sessions, err = listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE (COALESCE(json_extract(payload_json, '$.source'), '') <> 'naming' OR status IN ('queued','running')) AND `+visibleAgentSessionSQL+` ORDER BY updated_at DESC LIMIT 80`)
	}
	if err != nil {
		return nil, err
	}
	return sessions, nil
}

func (s *Store) GetAgentSession(ctx context.Context, id string) (store.AgentSession, error) {
	session, err := getJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE id = ? AND `+visibleAgentSessionSQL, id)
	if err != nil {
		return store.AgentSession{}, err
	}
	if err := s.attachAgentSessionEvents(ctx, &session); err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}

// Routing a daemon request needs identity and status, not the entire transcript.
func (s *Store) GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error) {
	return getJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events', '$.response', '$.importedContext', '$.profileTransitionNote'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE id = ? AND `+visibleAgentSessionSQL, id)
}

func (s *Store) CreateAgentSession(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	var result store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		var err error
		result, err = tx.createAgentSession(ctx, input)
		return err
	})
	return result, err
}

func (s *Store) createAgentSession(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	prompt := strings.TrimSpace(input.Prompt)
	attachments := normalizeChatAttachments(input.Attachments)
	if prompt == "" && len(attachments) == 0 {
		return store.AgentSession{}, errors.New("agent session prompt is required")
	}
	agent, err := s.resolveSessionAgent(ctx, input)
	if err != nil {
		return store.AgentSession{}, err
	}
	// A request's provider must match the identity the server resolved; it is
	// never allowed to route a claude prompt onto a codex profile (or vice
	// versa). Persisted daemon agents already carry their provider the same
	// way, so this is identity confirmation, not client-trusted input.
	if input.Provider != "" && agent.Provider != input.Provider {
		return store.AgentSession{}, store.ErrNotFound
	}
	if err := s.assertDeviceNotRemoved(ctx, agent.DeviceID); err != nil {
		return store.AgentSession{}, err
	}
	// Lineage: a parent must be a visible session in the same workspace the
	// request resolves to. The automatic group placement happens in this same
	// transaction once the child row exists.
	parent, err := s.ValidateParentSession(ctx, agent.WorkspaceID, strings.TrimSpace(input.ParentSessionID))
	if err != nil {
		return store.AgentSession{}, err
	}
	if parent.ID != "" {
		depth, err := s.SessionLineageDepth(ctx, parent.ID)
		if err != nil {
			return store.AgentSession{}, err
		}
		if depth >= maxAgentSessionLineageDepth {
			return store.AgentSession{}, store.ErrAgentLineageTooDeep
		}
		activeChildren, err := s.CountActiveAgentChildren(ctx, agent.WorkspaceID, parent.ID)
		if err != nil {
			return store.AgentSession{}, err
		}
		if activeChildren >= maxActiveAgentChildrenPerParent {
			return store.AgentSession{}, store.ErrAgentFanOutLimit
		}
	}
	now := time.Now().UTC()
	source := strings.TrimSpace(input.Source)
	if source != "diagnostic" && source != "naming" && source != "agent" && source != "verification" {
		source = "chat"
	}
	if source == "naming" && (input.NativeSessionID != "" || input.ThreadID != "" || input.ImportedContext != "" || input.ProfileTransitionNote != "" || len(input.Attachments) > 0) {
		return store.AgentSession{}, errors.New("naming must start an independent session without inherited context")
	}
	threadID := strings.TrimSpace(input.ThreadID)
	deleted, err := s.chatDeleted(ctx, agent.WorkspaceID, threadID, agent.Provider, strings.TrimSpace(input.NativeSessionID))
	if err != nil {
		return store.AgentSession{}, err
	}
	if deleted {
		return store.AgentSession{}, store.ErrNotFound
	}
	// A worktree-backed session requires a live candidate environment: the
	// Issue must belong to the same workspace and be past contract start.
	issueID := strings.TrimSpace(input.IssueID)
	if issueID != "" {
		issue, err := s.GetIssue(ctx, issueID)
		if err != nil {
			return store.AgentSession{}, store.ErrIssueEnvironmentUnavailable
		}
		if issue.WorkspaceID != agent.WorkspaceID {
			return store.AgentSession{}, store.ErrIssueEnvironmentUnavailable
		}
		switch issue.Status {
		case "in_progress", "blocked", "verifying":
		default:
			return store.AgentSession{}, store.ErrIssueEnvironmentUnavailable
		}
	}

	titleInput := prompt
	if titleInput == "" && len(attachments) > 0 {
		titleInput = attachments[0].Name
		if len(attachments) > 1 {
			titleInput = fmt.Sprintf("%s + %d files", titleInput, len(attachments)-1)
		}
	}
	createdBy := input.CreatedByUserID
	if createdBy == "" {
		createdBy = parent.CreatedByUserID
	}
	session := store.AgentSession{
		CreatedByUserID:       createdBy,
		ID:                    fmt.Sprintf("sess_%d", now.UnixNano()),
		NativeSessionID:       strings.TrimSpace(input.NativeSessionID),
		WorkspaceID:           agent.WorkspaceID,
		AgentID:               agent.ID,
		DeviceID:              agent.DeviceID,
		Provider:              agent.Provider,
		ProfileID:             agent.ProfileID,
		ProfileFingerprint:    agent.ProfileFingerprint,
		ProfileLabel:          agent.ProfileLabel,
		Source:                source,
		ParentSessionID:       parent.ID,
		IssueID:               issueID,
		Model:                 strings.TrimSpace(input.Model),
		ClaudeEffort:          strings.TrimSpace(input.ClaudeEffort),
		ClaudePermissionMode:  strings.TrimSpace(input.ClaudePermissionMode),
		CodexReasoningEffort:  strings.TrimSpace(input.CodexReasoningEffort),
		CodexSandboxMode:      strings.TrimSpace(input.CodexSandboxMode),
		CodexApprovalPolicy:   strings.TrimSpace(input.CodexApprovalPolicy),
		CodexSpeed:            strings.TrimSpace(input.CodexSpeed),
		Status:                "queued",
		Title:                 titleFromInput(titleInput),
		Prompt:                prompt,
		Attachments:           attachments,
		ProfileTransitionNote: strings.TrimSpace(input.ProfileTransitionNote),
		ImportedContext:       strings.TrimSpace(input.ImportedContext),
		CreatedLabel:          "just now",
		UpdatedLabel:          "queued",
		Events:                []store.AgentSessionEvent{},
	}
	// Verification sessions are independent read-only judges: force the
	// read-only runtime knobs server-side, never trusting client input.
	if source == "verification" {
		session.ClaudePermissionMode = "plan"
		session.CodexSandboxMode = "read-only"
		session.CodexApprovalPolicy = "never"
	}
	if threadID != "" && (source == "chat" || source == "agent") {
		session.ThreadID = threadID
	} else if source == "chat" || source == "agent" {
		session.ThreadID = session.ID
	}
	if source == "chat" || source == "agent" {
		if err := s.prepareChatNativeLeg(ctx, &session); err != nil {
			return store.AgentSession{}, err
		}
	}
	if err := s.saveAgentSession(ctx, session, now, now); err != nil {
		return store.AgentSession{}, err
	}
	if parent.ID != "" {
		createdGroupID, created, err := s.PlaceChildWithParent(ctx, parent, session.ID)
		if err != nil {
			return store.AgentSession{}, err
		}
		if created {
			session.CreatedGroupID = createdGroupID
			if err := s.saveAgentSession(ctx, session, now, now); err != nil {
				return store.AgentSession{}, err
			}
		}
	}
	return session, nil
}

func normalizeChatAttachments(attachments []store.ChatAttachment) []store.ChatAttachment {
	if len(attachments) == 0 {
		return nil
	}
	result := make([]store.ChatAttachment, 0, len(attachments))
	seen := map[string]bool{}
	for _, attachment := range attachments {
		id := strings.TrimSpace(attachment.ID)
		path := strings.TrimSpace(attachment.Path)
		if id == "" || path == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(attachment.Name)
		if name == "" {
			name = filepath.Base(path)
		}
		kind := strings.TrimSpace(attachment.Kind)
		if kind != "image" {
			kind = "file"
		}
		result = append(result, store.ChatAttachment{
			ID:       id,
			Name:     name,
			Path:     path,
			MIMEType: strings.TrimSpace(attachment.MIMEType),
			Size:     attachment.Size,
			Kind:     kind,
		})
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func (s *Store) prepareChatNativeLeg(ctx context.Context, session *store.AgentSession) error {
	if session.ThreadID == "" {
		return nil
	}
	sessions, err := s.ListAgentSessionSummaries(ctx, session.WorkspaceID)
	if err != nil {
		return err
	}
	for _, existing := range sessions {
		if session.NativeSessionID != "" &&
			existing.NativeSessionID == session.NativeSessionID &&
			isActiveAgentSession(existing.Status) {
			return errors.New("agent session is already active for this native session")
		}
		if existing.ThreadID == session.ThreadID && isActiveAgentSession(existing.Status) {
			return errors.New("agent session is already active in this chat")
		}
		if existing.ThreadID != session.ThreadID ||
			!compatibleAgentSessionProfile(existing, *session) {
			continue
		}
		if isActiveAgentSession(existing.Status) {
			return errors.New("agent session is already active for this profile in this chat")
		}
		if session.NativeSessionID == "" &&
			existing.NativeSessionID != "" &&
			existing.Status == "completed" {
			session.NativeSessionID = existing.NativeSessionID
			return nil
		}
	}
	return nil
}

func isActiveAgentSession(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}

func isTerminalAgentSession(status string) bool {
	return status == "completed" || status == "failed" || status == "canceled"
}

func compatibleAgentSessionProfile(left store.AgentSession, right store.AgentSession) bool {
	if left.Provider != right.Provider {
		return false
	}
	if left.ProfileID != "" && right.ProfileID != "" && left.ProfileID == right.ProfileID {
		return true
	}
	if left.ProfileFingerprint != "" &&
		right.ProfileFingerprint != "" &&
		left.ProfileFingerprint == right.ProfileFingerprint {
		return true
	}
	return false
}

func (s *Store) StartAgentSession(ctx context.Context, id string) (store.AgentSession, error) {
	// Gate and transition in one serialized transaction: if a concurrent
	// SoftRemoveDevice commits first, the queued session must not flip to
	// running on a device that is already disconnected for good.
	var session store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		existing, err := tx.GetAgentSession(ctx, id)
		if err != nil {
			return err
		}
		if err := tx.assertDeviceNotRemoved(ctx, existing.DeviceID); err != nil {
			return err
		}
		if isTerminalAgentSession(existing.Status) {
			session = existing
			return nil
		}
		if existing.Status == "running" && existing.StartedAt != "" {
			session = existing
			return nil
		}
		now := time.Now().UTC()
		existing.Status = "running"
		existing.BlockedReason = ""
		existing.StartedAt = formatTime(now)
		existing.CompletedAt = ""
		existing.UpdatedLabel = "running"
		if err := tx.saveAgentSession(ctx, existing, time.Time{}, now); err != nil {
			return err
		}
		session = existing
		return nil
	})
	if err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}

func (s *Store) AppendAgentSessionEvent(ctx context.Context, event store.AgentSessionEvent) error {
	now := time.Now().UTC()
	event.At = formatTime(now)
	return s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `UPDATE agent_sessions
			SET payload_json = CASE
					WHEN status IN ('queued', 'running')
					THEN json_set(payload_json, '$.updatedLabel', 'running')
					ELSE payload_json
				END,
				updated_at = ?
			WHERE id = ?`, formatTime(now), event.SessionID)
		if err != nil {
			return fmt.Errorf("touch agent session: %w", err)
		}
		rowsAffected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("check agent session update: %w", err)
		}
		if rowsAffected == 0 {
			return store.ErrNotFound
		}
		return tx.saveAgentSessionEvent(ctx, event, now)
	})
}

func (s *Store) SetAgentSessionNativeSessionID(ctx context.Context, sessionID string, nativeSessionID string) (store.AgentSession, error) {
	session, err := s.GetAgentSession(ctx, sessionID)
	if err != nil {
		return store.AgentSession{}, err
	}
	nativeSessionID = strings.TrimSpace(nativeSessionID)
	if nativeSessionID == "" {
		return session, nil
	}
	if session.NativeSessionID == nativeSessionID {
		return session, nil
	}
	session.NativeSessionID = nativeSessionID
	now := time.Now().UTC()
	if err := s.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}

func (s *Store) CompleteAgentSession(ctx context.Context, id string, response string, nativeSessionID string) (store.AgentSession, error) {
	var session store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		var err error
		session, err = tx.completeAgentSession(ctx, id, response, nativeSessionID)
		return err
	})
	return session, err
}

func (s *Store) completeAgentSession(ctx context.Context, id string, response string, nativeSessionID string) (store.AgentSession, error) {
	session, err := s.GetAgentSession(ctx, id)
	if err != nil {
		return store.AgentSession{}, err
	}
	if isTerminalAgentSession(session.Status) {
		return session, nil
	}
	session.Status = "completed"
	session.Response = strings.TrimSpace(response)
	session.Error = ""
	if nativeSessionID = strings.TrimSpace(nativeSessionID); nativeSessionID != "" {
		session.NativeSessionID = nativeSessionID
	}
	now := time.Now().UTC()
	if session.StartedAt == "" {
		session.StartedAt = formatTime(now)
	}
	session.CompletedAt = formatTime(now)
	session.UpdatedLabel = "completed"
	if session.Response != "" {
		session.AnswerRevision = session.ID + ":" + session.CompletedAt
	}
	if session.Source == "naming" && strings.TrimSpace(session.GroupNameTarget) == "" {
		if err := s.completeChatTitleJob(ctx, session); err != nil {
			session.Status = "failed"
			session.Error = err.Error()
			session.UpdatedLabel = "failed"
		}
	}
	if err := s.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
		return store.AgentSession{}, err
	}
	if err := s.deleteClaimedNativeChat(ctx, session); err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}

func (s *Store) FailAgentSession(ctx context.Context, id string, message string) (store.AgentSession, error) {
	session, err := s.GetAgentSession(ctx, id)
	if err != nil {
		return store.AgentSession{}, err
	}
	if isTerminalAgentSession(session.Status) {
		return session, nil
	}
	session.Status = "failed"
	session.Error = strings.TrimSpace(message)
	now := time.Now().UTC()
	if session.StartedAt == "" {
		session.StartedAt = formatTime(now)
	}
	session.CompletedAt = formatTime(now)
	session.UpdatedLabel = "failed"
	if err := s.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}

func (s *Store) CancelAgentSession(ctx context.Context, id string, message string) (store.AgentSession, error) {
	session, err := s.GetAgentSession(ctx, id)
	if err != nil {
		return store.AgentSession{}, err
	}
	if isTerminalAgentSession(session.Status) {
		return session, nil
	}
	session.Status = "canceled"
	session.Error = strings.TrimSpace(message)
	now := time.Now().UTC()
	if session.StartedAt == "" {
		session.StartedAt = formatTime(now)
	}
	session.CompletedAt = formatTime(now)
	session.UpdatedLabel = "canceled"
	if err := s.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}

// BlockAgentSession marks a running session as blocked on a wait condition
// (permission prompt, model rate limit). It stays active: steer/cancel remain
// valid and the daemon still owns the process.
func (s *Store) BlockAgentSession(ctx context.Context, id string, reason string) (store.AgentSession, error) {
	return s.transitionAgentSessionBlocked(ctx, id, strings.TrimSpace(reason), true)
}

// ResumeAgentSession clears the blocked marker back to running.
func (s *Store) ResumeAgentSession(ctx context.Context, id string) (store.AgentSession, error) {
	return s.transitionAgentSessionBlocked(ctx, id, "", false)
}

func (s *Store) transitionAgentSessionBlocked(ctx context.Context, id string, reason string, blocked bool) (store.AgentSession, error) {
	var result store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		session, err := tx.GetAgentSession(ctx, id)
		if err != nil {
			return err
		}
		if isTerminalAgentSession(session.Status) {
			return store.ErrNotFound
		}
		if blocked {
			if session.Status != "running" && session.Status != "blocked" {
				return store.ErrNotFound
			}
			if reason == "" {
				reason = "waiting"
			}
			session.Status = "blocked"
		} else {
			session.Status = "running"
			reason = ""
		}
		session.BlockedReason = reason
		session.UpdatedLabel = session.Status
		now := time.Now().UTC()
		if err := tx.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
			return err
		}
		result = session
		return nil
	})
	return result, err
}
