package sqlitestore

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
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
		sessions[index].Input.ImportedContext = ""
		sessions[index].Input.ProfileTransitionNote = ""
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
		sessions, err = listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE workspace_id = ? AND (COALESCE(json_extract(payload_json, '$.source'), '') <> 'naming' OR status IN ('queued','running')) AND `+visibleAgentSessionSQL+` ORDER BY activity_at DESC, id DESC LIMIT 80`, workspaceID)
	} else {
		sessions, err = listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE (COALESCE(json_extract(payload_json, '$.source'), '') <> 'naming' OR status IN ('queued','running')) AND `+visibleAgentSessionSQL+` ORDER BY activity_at DESC, id DESC LIMIT 80`)
	}
	if err != nil {
		return nil, err
	}
	return sessions, nil
}

// UnsettledAgentSessionsOnDevice returns summaries of the device's queued,
// running and blocked sessions in every workspace, oldest first.
func (s *Store) UnsettledAgentSessionsOnDevice(ctx context.Context, deviceID string) ([]store.AgentSession, error) {
	sessions, err := listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE device_id = ? AND status IN ('queued','running','blocked') AND `+visibleAgentSessionSQL+` ORDER BY created_at`, deviceID)
	if err != nil {
		return nil, err
	}
	for index := range sessions {
		sessions[index].Input.ImportedContext = ""
		sessions[index].Response = ""
		sessions[index].Events = nil
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
	return getJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events', '$.response', '$.input.importedContext', '$.input.profileTransitionNote'), '$.lastActivityAt', updated_at) FROM agent_sessions WHERE id = ? AND `+visibleAgentSessionSQL, id)
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
	attachments := store.NormalizeChatAttachments(input.Attachments)
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
	source := strings.TrimSpace(input.Source)
	if source != "diagnostic" && source != "naming" && source != "agent" && source != "verification" {
		source = "chat"
	}
	// Lineage: a parent must be a visible session in the same workspace the
	// request resolves to, except that an agent may start a session in another
	// workspace its token reaches (authorized before the store is called). The
	// automatic group placement happens in this same transaction once the child
	// row exists, and only within one workspace's layout.
	parent, err := s.ValidateParentSession(ctx, agent.WorkspaceID, strings.TrimSpace(input.ParentSessionID), source == "agent")
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
		activeChildren, err := s.CountActiveAgentChildren(ctx, parent.ID)
		if err != nil {
			return store.AgentSession{}, err
		}
		if activeChildren >= maxActiveAgentChildrenPerParent {
			return store.AgentSession{}, store.ErrAgentFanOutLimit
		}
	}
	now := time.Now().UTC()
	if source == "naming" && (input.NativeSessionID != "" || input.ChatID != "" || input.ForkSessionID != "" || input.ImportedContext != "" || input.ProfileTransitionNote != "" || len(input.Attachments) > 0) {
		return store.AgentSession{}, errors.New("naming must start an independent session without inherited context")
	}
	deleted, err := s.chatDeleted(ctx, agent.WorkspaceID, "", agent.Provider, strings.TrimSpace(input.NativeSessionID))
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

	inputID, err := s.sessionInputID(ctx, input.InputID, now)
	if err != nil {
		return store.AgentSession{}, err
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
	id := fmt.Sprintf("sess_%d", now.UnixNano())
	session := store.AgentSession{
		CreatedByUserID:      createdBy,
		ID:                   id,
		ThreadID:             id,
		WorkspaceID:          agent.WorkspaceID,
		AgentID:              agent.ID,
		DeviceID:             agent.DeviceID,
		Provider:             agent.Provider,
		ProfileID:            agent.ProfileID,
		ProfileFingerprint:   agent.ProfileFingerprint,
		ProfileLabel:         agent.ProfileLabel,
		Source:               source,
		ParentSessionID:      parent.ID,
		IssueID:              issueID,
		Model:                strings.TrimSpace(input.Model),
		ClaudeEffort:         strings.TrimSpace(input.ClaudeEffort),
		ClaudePermissionMode: strings.TrimSpace(input.ClaudePermissionMode),
		CodexReasoningEffort: strings.TrimSpace(input.CodexReasoningEffort),
		CodexSandboxMode:     strings.TrimSpace(input.CodexSandboxMode),
		CodexApprovalPolicy:  strings.TrimSpace(input.CodexApprovalPolicy),
		CodexSpeed:           strings.TrimSpace(input.CodexSpeed),
		Status:               "queued",
		Title:                titleFromInput(titleInput),
		Prompt:               prompt,
		Input: store.SessionInput{
			ID:                    inputID,
			At:                    formatTime(now),
			Prompt:                prompt,
			Attachments:           attachments,
			ProfileTransitionNote: strings.TrimSpace(input.ProfileTransitionNote),
			ImportedContext:       strings.TrimSpace(input.ImportedContext),
		},
		CreatedLabel: "just now",
		UpdatedLabel: "queued",
		Events:       []store.AgentSessionEvent{},
	}
	// Verification sessions are independent read-only judges: force the
	// read-only runtime knobs server-side, never trusting client input.
	if source == "verification" {
		session.ClaudePermissionMode = "plan"
		session.CodexSandboxMode = "read-only"
		session.CodexApprovalPolicy = "never"
	}
	if err := s.bindNativeSession(ctx, &session, input, now); err != nil {
		return store.AgentSession{}, err
	}
	if err := s.saveAgentSession(ctx, session, now, now); err != nil {
		return store.AgentSession{}, err
	}
	if err := s.recordSessionInput(ctx, session.ID, session.Input, now); err != nil {
		return store.AgentSession{}, err
	}
	// A session working inside an Issue belongs to that Issue and is listed
	// there; it gets no Chats group, which would only ever stay empty.
	if parent.ID != "" && parent.WorkspaceID == session.WorkspaceID && session.IssueID == "" {
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

// newSessionInputID is a UUIDv7: Claude accepts it as the native user
// message uuid, and ids sort by time, which keeps artifact order.
func newSessionInputID(now time.Time) string {
	var id [16]byte
	ms := uint64(now.UnixMilli())
	for i := 0; i < 6; i++ {
		id[i] = byte(ms >> (40 - 8*i))
	}
	rand.Read(id[6:]) // never fails since Go 1.24
	id[6] = id[6]&0x0f | 0x70
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

// sessionInputID is the id a new input gets: the one its sender chose (a
// queued message's), unless a session already recorded that input.
func (s *Store) sessionInputID(ctx context.Context, requested string, now time.Time) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return newSessionInputID(now), nil
	}
	var recorded bool
	if err := s.conn().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM agent_session_events WHERE id = ?)`, "evt_"+requested).Scan(&recorded); err != nil {
		return "", err
	}
	if recorded {
		return "", store.ErrSessionInputExists
	}
	return requested, nil
}

// recordSessionInput writes the input into the session's transcript.
func (s *Store) recordSessionInput(ctx context.Context, sessionID string, input store.SessionInput, now time.Time) error {
	if input.At == "" {
		input.At = formatTime(now)
	}
	for index, event := range store.SessionInputEvents(sessionID, input) {
		// Distinct creation times keep the boundary ahead of the message.
		if err := s.saveAgentSessionEvent(ctx, event, now.Add(time.Duration(index)*time.Microsecond)); err != nil {
			return err
		}
	}
	return nil
}

// recordInputAnswer keeps the answer to the current input in the transcript.
// Streaming runtimes already wrote it as events; other paths (custom command
// profiles, CLI fallbacks) only report it on completion, and Response is
// cleared by the next input.
func (s *Store) recordInputAnswer(ctx context.Context, session store.AgentSession, now time.Time) error {
	answer := strings.TrimSpace(session.Response)
	if answer == "" || session.Input.ID == "" {
		return nil
	}
	events, err := listJSON[store.AgentSessionEvent](ctx, s.conn(), `SELECT payload_json FROM agent_session_events
		WHERE session_id = ? ORDER BY created_at DESC, id DESC`, session.ID)
	if err != nil {
		return err
	}
	for _, event := range events {
		if event.ID == "evt_"+session.Input.ID {
			break
		}
		if event.Message != nil && event.Message.Kind == "assistant" && strings.TrimSpace(event.Message.Text) == answer {
			return nil
		}
		if event.Label == "Response stream" && (event.Metadata == nil || event.Metadata.TaskID == "") && strings.TrimSpace(event.Detail) == answer {
			return nil
		}
	}
	return s.saveAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID: "evt_" + session.Input.ID + "_answer", SessionID: session.ID, At: formatTime(now),
		Label: "Response stream", Detail: answer, Level: "info",
	}, now)
}

// SendAgentSessionInput gives an idle session its next input. The session
// returns to queued on its native session for the runtime it now runs on,
// told the turns that ran elsewhere; a runtime it has not run on starts a
// native session told the whole conversation.
func (s *Store) SendAgentSessionInput(ctx context.Context, sessionID string, input store.SendAgentSessionInput) (store.AgentSession, error) {
	var result store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		session, err := tx.GetAgentSessionSummary(ctx, sessionID)
		if err != nil {
			return err
		}
		if isActiveAgentSession(session.Status) {
			return store.ErrAgentSessionActive
		}
		if session.Source == "naming" || session.Source == "diagnostic" {
			return errors.New("utility sessions take no further input")
		}
		if session.Role != "" {
			return store.ErrSessionControlledByIssue
		}
		prompt := strings.TrimSpace(input.Prompt)
		attachments := store.NormalizeChatAttachments(input.Attachments)
		if prompt == "" && len(attachments) == 0 {
			return errors.New("agent session prompt is required")
		}
		if input.AgentID != "" || input.Provider != "" || input.ProfileID != "" {
			agent, err := tx.resolveSessionAgent(ctx, store.CreateAgentSessionInput{
				WorkspaceID: session.WorkspaceID, AgentID: input.AgentID, Provider: input.Provider, ProfileID: input.ProfileID,
			})
			if err != nil {
				return err
			}
			if input.Provider != "" && agent.Provider != input.Provider {
				return store.ErrNotFound
			}
			if err := tx.assertDeviceNotRemoved(ctx, agent.DeviceID); err != nil {
				return err
			}
			next := session
			next.AgentID, next.DeviceID, next.Provider = agent.ID, agent.DeviceID, agent.Provider
			next.ProfileID, next.ProfileFingerprint, next.ProfileLabel = agent.ProfileID, agent.ProfileFingerprint, agent.ProfileLabel
			if !compatibleAgentSessionProfile(session, next) {
				// A model or setting chosen for the previous agent or account
				// may not exist for the new one; it starts from its defaults.
				next.Model = ""
				if next.Provider != session.Provider {
					next.ClaudeEffort, next.ClaudePermissionMode = "", ""
					next.CodexReasoningEffort, next.CodexSandboxMode, next.CodexApprovalPolicy, next.CodexSpeed = "", "", "", ""
				}
			}
			session = next
		}
		if model := strings.TrimSpace(input.Model); model != "" {
			session.Model = model
		}
		for target, value := range map[*string]string{
			&session.ClaudeEffort: input.ClaudeEffort, &session.ClaudePermissionMode: input.ClaudePermissionMode,
			&session.CodexReasoningEffort: input.CodexReasoningEffort, &session.CodexSandboxMode: input.CodexSandboxMode,
			&session.CodexApprovalPolicy: input.CodexApprovalPolicy, &session.CodexSpeed: input.CodexSpeed,
		} {
			if value = strings.TrimSpace(value); value != "" && session.Source != "verification" {
				*target = value
			}
		}
		now := time.Now().UTC()
		inputID, err := tx.sessionInputID(ctx, input.InputID, now)
		if err != nil {
			return err
		}
		previousInputID := session.Input.ID
		session.Input = store.SessionInput{
			ID:                    inputID,
			At:                    formatTime(now),
			Prompt:                prompt,
			Attachments:           attachments,
			ProfileTransitionNote: strings.TrimSpace(input.ProfileTransitionNote),
		}
		// What the native session missed is the server's to tell, never the
		// client's: it alone knows which turns each native session ran.
		missed, err := tx.resumeNativeSession(ctx, &session, previousInputID, session.Input.ID)
		if err != nil {
			return err
		}
		session.Input.ImportedContext = missed
		session.Status = "queued"
		session.Response, session.Error, session.BlockedReason = "", "", ""
		session.StartedAt, session.CompletedAt = "", ""
		session.UpdatedLabel = "queued"
		if err := tx.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
			return err
		}
		if err := tx.recordSessionInput(ctx, session.ID, session.Input, now); err != nil {
			return err
		}
		result = session
		return nil
	})
	return result, err
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

// SetAgentSessionNativeSessionID records the native session the worker runs
// the session's current input on.
func (s *Store) SetAgentSessionNativeSessionID(ctx context.Context, sessionID string, nativeSessionID string) (store.AgentSession, error) {
	var result store.AgentSession
	err := s.withTx(ctx, func(tx *Store) error {
		session, err := tx.GetAgentSession(ctx, sessionID)
		if err != nil {
			return err
		}
		result = session
		nativeSessionID = strings.TrimSpace(nativeSessionID)
		if nativeSessionID == "" {
			return nil
		}
		if err := tx.attachNativeSession(ctx, &session, nativeSessionID, session.Input.ID); err != nil {
			return err
		}
		if session.NativeSessionID == result.NativeSessionID {
			return nil
		}
		if err := tx.saveAgentSession(ctx, session, time.Time{}, time.Now().UTC()); err != nil {
			return err
		}
		result = session
		return nil
	})
	return result, err
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
	if err := s.attachNativeSession(ctx, &session, nativeSessionID, session.Input.ID); err != nil {
		return store.AgentSession{}, err
	}
	settleNativeFork(&session)
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
	if err := s.recordInputAnswer(ctx, session, now); err != nil {
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
