package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) reconcileAgentSession(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error) {
	result, recovered, err := reconcileAgentSession(ctx, s.store, s.events, session, s.options.AgentSessionStaleAfter, s.hub.HasActiveSession)
	if recovered && err == nil {
		s.titles.SessionCompleted(ctx, result)
	}
	return result, recovered, err
}

func (s *Server) reconcileAgentSessions(ctx context.Context, sessions []store.AgentSession) []store.AgentSession {
	for index := range sessions {
		session, recovered, err := s.reconcileAgentSession(ctx, sessions[index])
		if err != nil {
			continue
		}
		if recovered {
			sessions[index] = session
		}
	}
	return sessions
}

func (h *DaemonHub) reconcileAgentSession(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error) {
	return reconcileAgentSession(ctx, h.store, h.events, session, defaultAgentSessionStaleAfter, h.HasActiveSession)
}

func reconcileAgentSession(ctx context.Context, st store.Store, events *browserEventHub, session store.AgentSession, staleAfter time.Duration, hasActiveSession func(deviceID string, sessionID string) bool) (store.AgentSession, bool, error) {
	if !isRecoverableAgentSessionStatus(session.Status) {
		return session, false, nil
	}
	workspace, err := st.GetWorkspace(ctx, session.WorkspaceID)
	if err != nil {
		return session, false, err
	}
	recovered, ok, err := completedAgentSessionFromArtifacts(workspace.LocalPath, session)
	if err != nil {
		return session, false, err
	}
	if ok {
		if recovered.NativeSessionID == "" {
			recovered.NativeSessionID = session.NativeSessionID
		}
		updated, err := st.CompleteAgentSession(ctx, session.ID, recovered.Response, recovered.NativeSessionID)
		if err != nil {
			return session, false, err
		}
		events.Publish("agent_session_completed", updated)
		return updated, true, nil
	}
	if message, stale := staleAgentSessionMessage(session, time.Now().UTC(), staleAfter, hasActiveSession); stale {
		updated, err := st.FailAgentSession(ctx, session.ID, message)
		if err != nil {
			return session, false, err
		}
		events.Publish("agent_session_completed", updated)
		return updated, true, nil
	}
	return session, false, nil
}

func staleAgentSessionMessage(session store.AgentSession, now time.Time, staleAfter time.Duration, hasActiveSession func(deviceID string, sessionID string) bool) (string, bool) {
	if session.Status != "running" && session.Status != "blocked" || staleAfter <= 0 {
		return "", false
	}
	// A reconnect of the same daemon process is authoritative even if a long
	// network outage made the persisted heartbeat stale. A replacement process
	// reuses the device ID but has an empty execution registry, so it cannot
	// accidentally keep the orphan alive.
	if hasActiveSession != nil && hasActiveSession(session.DeviceID, session.ID) {
		return "", false
	}
	activityAt := strings.TrimSpace(session.LastActivityAt)
	if activityAt == "" {
		activityAt = strings.TrimSpace(session.StartedAt)
	}
	lastActivity, err := time.Parse(time.RFC3339Nano, activityAt)
	if err != nil || now.Sub(lastActivity) < staleAfter {
		return "", false
	}
	return fmt.Sprintf(
		"Local daemon stopped reporting session activity for %s; marked failed to clear a stale running session.",
		staleDurationLabel(now.Sub(lastActivity)),
	), true
}

func staleDurationLabel(duration time.Duration) string {
	duration = duration.Round(time.Second)
	if duration < time.Minute {
		return duration.String()
	}
	return duration.Round(time.Minute).String()
}

func isRecoverableAgentSessionStatus(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}

type recoveredAgentSession struct {
	NativeSessionID string
	Response        string
}

type agentSessionCompletionMarker struct {
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	Response        string `json:"response"`
	SessionID       string `json:"sessionId"`
	Status          string `json:"status"`
}

func completedAgentSessionFromArtifacts(workspacePath string, session store.AgentSession) (recoveredAgentSession, bool, error) {
	workspacePath = strings.TrimSpace(workspacePath)
	if workspacePath == "" || strings.TrimSpace(session.ID) == "" {
		return recoveredAgentSession{}, false, nil
	}
	sessionDir := filepath.Join(workspacePath, ".foundry", "sessions", session.ID)
	if recovered, ok, err := completedAgentSessionFromMarker(sessionDir, session.ID); err != nil || ok {
		return recovered, ok, err
	}

	resultPath := filepath.Join(sessionDir, "result.md")
	responseBytes, err := os.ReadFile(resultPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return recoveredAgentSession{}, false, nil
		}
		return recoveredAgentSession{}, false, err
	}
	response := strings.TrimSpace(string(responseBytes))
	if response == "" {
		return recoveredAgentSession{}, false, nil
	}

	if recovered, ok, err := completedClaudeAgentSessionFromArtifacts(sessionDir); err != nil || ok {
		recovered.Response = response
		return recovered, ok, err
	}
	if recovered, ok, err := completedCodexAgentSessionFromArtifacts(sessionDir); err != nil || ok {
		recovered.Response = response
		return recovered, ok, err
	}
	return recoveredAgentSession{}, false, nil
}

func completedAgentSessionFromMarker(sessionDir string, sessionID string) (recoveredAgentSession, bool, error) {
	markerPath := filepath.Join(sessionDir, "completion.json")
	bytes, err := os.ReadFile(markerPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return recoveredAgentSession{}, false, nil
		}
		return recoveredAgentSession{}, false, err
	}

	var marker agentSessionCompletionMarker
	if err := json.Unmarshal(bytes, &marker); err != nil {
		return recoveredAgentSession{}, false, err
	}
	if marker.SessionID != sessionID || marker.Status != "completed" {
		return recoveredAgentSession{}, false, nil
	}
	response := strings.TrimSpace(marker.Response)
	if response == "" {
		return recoveredAgentSession{}, false, nil
	}
	return recoveredAgentSession{
		NativeSessionID: strings.TrimSpace(marker.NativeSessionID),
		Response:        response,
	}, true, nil
}

func completedClaudeAgentSessionFromArtifacts(sessionDir string) (recoveredAgentSession, bool, error) {
	messagesPath := filepath.Join(sessionDir, "claude-sdk.messages.jsonl")
	file, err := os.Open(messagesPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return recoveredAgentSession{}, false, nil
		}
		return recoveredAgentSession{}, false, err
	}
	defer file.Close()

	var recovered recoveredAgentSession
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var message map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		if nativeSessionID := stringValue(message, "session_id", "sessionId"); nativeSessionID != "" {
			recovered.NativeSessionID = nativeSessionID
		}
		if message["type"] != "result" {
			continue
		}
		if value, ok := message["is_error"].(bool); ok && value {
			continue
		}
		if subtype := strings.TrimSpace(stringValue(message, "subtype")); subtype != "" && subtype != "success" {
			continue
		}
		return recovered, true, nil
	}
	if err := scanner.Err(); err != nil {
		return recoveredAgentSession{}, false, err
	}
	return recoveredAgentSession{}, false, nil
}

func completedCodexAgentSessionFromArtifacts(sessionDir string) (recoveredAgentSession, bool, error) {
	eventsPath := filepath.Join(sessionDir, "codex-sdk.events.jsonl")
	file, err := os.Open(eventsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return recoveredAgentSession{}, false, nil
		}
		return recoveredAgentSession{}, false, err
	}
	defer file.Close()

	var recovered recoveredAgentSession
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var event map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue
		}
		if nativeSessionID := stringValue(event, "thread_id", "threadId"); nativeSessionID != "" {
			recovered.NativeSessionID = nativeSessionID
		}
		if event["type"] == "turn.completed" {
			return recovered, true, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return recoveredAgentSession{}, false, err
	}
	return recoveredAgentSession{}, false, nil
}

func stringValue(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}
