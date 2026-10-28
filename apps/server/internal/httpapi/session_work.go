package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionwork"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) workStore() (store.WorkStore, error) {
	w, ok := s.store.(store.WorkStore)
	if !ok {
		return nil, errors.New("session work storage unavailable")
	}
	return w, nil
}

func (s *Server) importSessionWork(ctx context.Context, session store.AgentSession) error {
	w, err := s.workStore()
	if err != nil {
		return err
	}
	if session.Scheduled != nil {
		var tasks []store.AgentScheduledTask
		for _, e := range session.Events {
			if e.Metadata != nil && e.Metadata.TimerSnapshot != nil {
				tasks = *e.Metadata.TimerSnapshot
			}
		}
		for _, timer := range session.Scheduled.Timers {
			index := slices.IndexFunc(tasks, func(t store.AgentScheduledTask) bool { return t.ID == timer.ID })
			if index < 0 {
				continue
			}
			if _, err = w.SaveSessionWork(ctx, sessionwork.Timer(session, store.SessionKeptTimer{AgentScheduledTask: tasks[index], FirstSeenAt: timer.FirstSeenAt})); err != nil {
				return err
			}
		}
	}
	for _, item := range sessionwork.FromEvents(session) {
		if _, err = w.SaveSessionWork(ctx, item); err != nil {
			return err
		}
	}
	return nil
}

// importThreadWork imports the work the thread's readable sessions record in
// their events, schedules and child sessions.
func (s *Server) importThreadWork(ctx context.Context, session store.AgentSession) error {
	w, err := s.workStore()
	if err != nil {
		return err
	}
	thread, err := w.SessionWorkSources(ctx, sessionwork.Thread(session))
	if err != nil {
		return err
	}
	for _, member := range thread {
		if !s.canReadSession(ctx, actorFromContext(ctx), member) {
			continue
		}
		if states, ok := s.store.(store.SessionStateStore); ok {
			member.Events, err = states.AgentSessionStateEvents(ctx, member.ID, "")
			if err != nil {
				return err
			}
		}
		// Importing writes only what is new. A database another process
		// holds locked past the busy timeout delays that import to the next
		// read; it does not fail this one.
		if err = s.importSessionWork(ctx, member); err != nil {
			if !store.IsBusy(err) {
				return err
			}
			log.Printf("session work: import for %s deferred: %v", member.ID, err)
		}
		if err = s.importWorkChildren(ctx, member); err != nil {
			if !store.IsBusy(err) {
				return err
			}
			log.Printf("session work: child import for %s deferred: %v", member.ID, err)
		}
	}
	return nil
}

func (s *Server) sessionWorkList(ctx context.Context, session store.AgentSession) (store.SessionWorkList, error) {
	w, err := s.workStore()
	if err != nil {
		return store.SessionWorkList{}, err
	}
	if err = s.importThreadWork(ctx, session); err != nil {
		return store.SessionWorkList{}, err
	}
	list, err := w.ListSessionWork(ctx, sessionwork.Thread(session), "")
	if err == nil {
		visible := list.Items[:0]
		for _, item := range list.Items {
			if !store.StandaloneSessionWork(item) {
				continue
			}
			owner, readErr := s.store.GetAgentSessionSummary(ctx, item.SessionID)
			if readErr == nil && s.canReadSession(ctx, actorFromContext(ctx), owner) {
				item.SharedSessionCount = len(item.RelatedSessionIDs)
				refs := []string{}
				for _, id := range item.RelatedSessionIDs {
					related, err := s.store.GetAgentSessionSummary(ctx, id)
					if err == nil && s.canReadSession(ctx, actorFromContext(ctx), related) {
						refs = append(refs, id)
						item.RelatedSessions = append(item.RelatedSessions, store.WorkSessionReference{ID: id, Title: related.Title, WorkspaceID: related.WorkspaceID})
					}
				}
				item.RelatedSessionIDs = refs
				visible = append(visible, item)
			}
		}
		list.Items = visible
		for _, item := range list.Items {
			if !strings.HasPrefix(item.SourceID, "coverage:") {
				continue
			}
			if item.Observation.Error == "" {
				list.Coverage[strings.TrimPrefix(item.SourceID, "coverage:")] = item.Observation.Status
			} else {
				list.Coverage[strings.TrimPrefix(item.SourceID, "coverage:")] = item.Observation.Error
			}
		}
	}
	if err == nil {
		projectWorkSchedulerReadiness(&list, time.Now().UTC())
	}
	return list, err
}

// Readiness is a read-time diagnostic. Device connectivity and the daemon's
// package version do not prove that its resident execution host has a scheduler.
// Never acknowledge controls or change stored device observations here.
func projectWorkSchedulerReadiness(list *store.SessionWorkList, now time.Time) {
	if list.Coverage == nil {
		list.Coverage = map[string]string{}
	}
	status := "not_observed"
	reason := "The device has not confirmed a work scheduler. Update this device's Worker and let its execution service switch when idle; registering work does not activate scheduling."
	if at, err := time.Parse(time.RFC3339Nano, list.Coverage["observedAt"]); err == nil {
		if age := now.Sub(at); age >= -5*time.Second && age < 90*time.Second {
			status, reason = "observed", ""
		} else {
			status = "stale"
			reason = "The work scheduler heartbeat is stale. Future wake-ups are unconfirmed until the device's execution service reconnects."
		}
	}
	list.Coverage["scheduler"] = status
	if reason != "" {
		list.Coverage["schedulerError"] = reason
	} else {
		delete(list.Coverage, "schedulerError")
	}
	for i := range list.Items {
		item := &list.Items[i]
		if reason != "" && item.Kind == "schedule" && item.Management == "managed" && item.DesiredState == "enabled" && item.Observation.Error == "" &&
			(!slices.Contains([]string{"completed", "stopped", "failed"}, item.Observation.Status) || item.Observation.ConfirmedRevision < item.Revision) {
			item.Observation.Error = reason
		}
	}
}

func (s *Server) handleListSessionWork(w http.ResponseWriter, r *http.Request) {
	list, err := s.sessionWorkList(r.Context(), guardedSession(r))
	writeResult(w, list, err)
}
func (s *Server) handleControlSessionWork(w http.ResponseWriter, r *http.Request) {
	session := guardedSession(r)
	if !s.canControlSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "you cannot control this session's work")
		return
	}
	var input store.WorkControlInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	result, err := s.controlWork(r.Context(), session, input)
	writeResult(w, result, err)
}
func (s *Server) controlWork(ctx context.Context, session store.AgentSession, input store.WorkControlInput) (store.WorkOperation, error) {
	s.workMu.Lock()
	defer s.workMu.Unlock()
	if input.Action == "adopt" && actorFromContext(ctx).Agent() {
		return store.WorkOperation{}, &statusError{http.StatusForbidden, errors.New("an unconfirmed OS task must be associated by the person before an agent may control it")}
	}
	if input.IdempotencyKey == "" || len(input.IdempotencyKey) > 160 {
		return store.WorkOperation{}, &statusError{http.StatusBadRequest, errors.New("idempotencyKey (at most 160 characters) required")}
	}
	if !slices.Contains([]string{"pause", "resume", "stop", "remove", "run", "adopt", "stop_all", "pause_all", "link", "unlink"}, input.Action) {
		return store.WorkOperation{}, &statusError{http.StatusBadRequest, errors.New("unknown work action")}
	}
	if input.Action == "link" || input.Action == "unlink" {
		related, err := s.store.GetAgentSessionSummary(ctx, input.RelatedSessionID)
		if err != nil || related.WorkspaceID != session.WorkspaceID || !s.canControlSession(ctx, actorFromContext(ctx), related) {
			return store.WorkOperation{}, &statusError{http.StatusForbidden, errors.New("you cannot associate this session with a service")}
		}
	}
	list, err := s.sessionWorkList(ctx, session)
	if err != nil {
		return store.WorkOperation{}, err
	}
	backing, _ := s.workStore()
	list, err = backing.ListSessionWork(ctx, sessionwork.Thread(session), "")
	if err != nil {
		return store.WorkOperation{}, err
	}
	for _, item := range list.Items {
		if input.Action == "stop_all" || input.Action == "pause_all" {
			action := "stop"
			if input.Action == "pause_all" {
				action = "pause"
			}
			if len(item.RelatedSessionIDs) > 0 || !slices.Contains(item.AllowedActions, action) {
				continue
			}
		}
		if input.Action != "stop_all" && input.Action != "pause_all" && input.ID != "" && input.ID != item.ID {
			continue
		}
		owner, readErr := s.store.GetAgentSessionSummary(ctx, item.SessionID)
		if readErr != nil || !s.canControlWorkSource(ctx, actorFromContext(ctx), item, owner) {
			return store.WorkOperation{}, &statusError{http.StatusForbidden, errors.New("you cannot control a descendant session's work")}
		}
	}

	op, err := backing.ControlSessionWork(ctx, sessionwork.Thread(session), session.ID, input)
	if err != nil {
		return op, &statusError{http.StatusConflict, err}
	}
	// Desired state is durable before an event is published or any device acts.
	s.workAudit(ctx, session, "Work control requested", op)
	return op, nil
}
func (s *Server) canControlWorkSource(ctx context.Context, actor Actor, item store.SessionWork, owner store.AgentSession) bool {
	if item.Source == "foundry" && item.Kind == "process" {
		scope, err := s.contextScope(ctx, actor)
		if err == nil && scope.issueID == "" && scope.can(item.WorkspaceID, store.WorkspaceRoleMember) {
			return true
		}
	}
	return s.canControlSession(ctx, actor, owner)
}

func (s *Server) workAudit(ctx context.Context, session store.AgentSession, label string, value any) {
	raw, _ := json.Marshal(value)
	event := store.AgentSessionEvent{ID: fmt.Sprintf("evt_work_%d", time.Now().UnixNano()), SessionID: session.ID, At: time.Now().UTC().Format(time.RFC3339Nano), Label: label, Detail: string(raw), Level: "info"}
	if s.store.AppendAgentSessionEvent(ctx, event) == nil {
		s.sessions.recorded(ctx, session.WorkspaceID, event)
	}
}

type createWorkInput struct {
	Title          string         `json:"title"`
	Spec           store.WorkSpec `json:"spec"`
	IdempotencyKey string         `json:"idempotencyKey"`
	Kind           string         `json:"kind"`
}

func (s *Server) createWork(ctx context.Context, session store.AgentSession, input createWorkInput) (store.SessionWork, error) {
	if session.ArchivedAt != "" {
		return store.SessionWork{}, store.ErrSessionArchived
	}
	if input.IdempotencyKey == "" || len(input.IdempotencyKey) > 160 {
		return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("idempotencyKey required")}
	}
	if input.Title == "" || len(input.Title) > 300 {
		return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("title (at most 300 characters) required")}
	}
	kind := input.Kind
	if kind == "" {
		kind = "schedule"
	}
	if kind != "schedule" && kind != "process" {
		return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("kind must be schedule or process")}
	}
	if input.Spec.ManualRunAt != "" || input.Spec.NativeSessionID != "" || input.Spec.ExpiresAt != "" {
		return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("manualRunAt, nativeSessionId and expiresAt are server-owned fields")}
	}
	if kind == "schedule" {
		if input.Spec.Prompt == "" || len(input.Spec.Prompt) > 64000 {
			return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("prompt (at most 64000 characters) required")}
		}
		if (input.Spec.At == "") == (input.Spec.Schedule == "") {
			return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("specify exactly one of schedule or at")}
		}
		if input.Spec.At != "" {
			if _, err := time.Parse(time.RFC3339Nano, input.Spec.At); err != nil {
				return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("at must be an RFC3339 instant")}
			}
		}
		if input.Spec.Schedule != "" && !sessionwork.ValidCron(input.Spec.Schedule) {
			return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("schedule must be a five-field cron")}
		}
		if input.Spec.TimeZone == "" {
			input.Spec.TimeZone = "UTC"
		}
		if _, err := time.LoadLocation(input.Spec.TimeZone); err != nil {
			return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("unknown IANA time zone")}
		}
		if input.Spec.Target != "" && input.Spec.Target != "continue_thread" && input.Spec.Target != "new_session" {
			return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("unknown schedule target")}
		}
		input.Spec.Recurring = input.Spec.Schedule != ""
	} else if len(input.Spec.Argv) == 0 {
		return store.SessionWork{}, &statusError{http.StatusBadRequest, errors.New("argv required")}
	}
	w := sessionwork.Base(session, kind, "foundry", input.IdempotencyKey, input.Title)
	w.Spec = input.Spec
	definition := w
	w.AllowedActions = []string{"stop", "remove", "resume", "pause"}
	if kind == "schedule" {
		w.AllowedActions = append(w.AllowedActions, "run")
	}
	backing, err := s.workStore()
	if err != nil {
		return w, err
	}
	w, err = backing.SaveSessionWork(ctx, w)
	if err == nil {
		storedSpec := w.Spec
		storedSpec.ManualRunAt = "" // Controls do not change the creation definition.
		if w.Title != definition.Title || w.Kind != definition.Kind || !reflect.DeepEqual(storedSpec, definition.Spec) {
			return w, &statusError{http.StatusConflict, errors.New("idempotency key already used for a different work definition")}
		}
		s.workAudit(ctx, session, "Work registered", map[string]string{"id": w.ID, "title": w.Title})
		if list, readErr := backing.ListSessionWork(ctx, sessionwork.Thread(session), ""); readErr == nil {
			list.Items = []store.SessionWork{w}
			projectWorkSchedulerReadiness(&list, time.Now().UTC())
			w = list.Items[0]
		}
	}
	return w, err
}
func (s *Server) handleCreateSessionWork(w http.ResponseWriter, r *http.Request) {
	session := guardedSession(r)
	if !s.canControlSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "you cannot create work for this session")
		return
	}
	var input createWorkInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	item, err := s.createWork(r.Context(), session, input)
	writeResult(w, item, err)
}

// Device sync is intentionally HTTP: execution-host owns one reconciler across
// daemon reconnects, and controls survive even when there is no open session turn.
func (s *Server) handleDeviceWork(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := actorFromContext(ctx)
	backing, err := s.workStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	deviceID := actor.DeviceID
	if r.Method == http.MethodPost {
		var body struct {
			Items    []store.SessionWork `json:"items"`
			Coverage map[string]string   `json:"coverage"`
		}
		if !decodeJSONRequest(w, r, &body) {
			return
		}
		if len(body.Items) > 500 {
			writeError(w, http.StatusBadRequest, "at most 500 observations")
			return
		}
		for _, item := range body.Items {
			session, err := s.store.GetAgentSessionSummary(ctx, item.SessionID)
			if err != nil || !actor.ActsAsDevice(session.DeviceID) {
				writeError(w, http.StatusNotFound, "not found")
				return
			}
			deviceID = session.DeviceID
			if item.ID != sessionwork.ID(session.ID, item.Source, item.SourceID) {
				writeError(w, http.StatusBadRequest, "invalid work identity")
				return
			}
			item.SessionID = session.ID
			item.ThreadID = sessionwork.Thread(session)
			item.WorkspaceID = session.WorkspaceID
			item.DeviceID = session.DeviceID
			observation := item.Observation
			// Registering a newly discovered definition cannot persist an ACK
			// before its revision has been checked against server-owned intent.
			item.Observation.ConfirmedRevision = 0
			saved, saveErr := backing.SaveSessionWork(ctx, item)
			if saveErr != nil {
				writeResult(w, nil, saveErr)
				return
			}
			if observation.ConfirmedRevision > saved.Revision {
				writeError(w, http.StatusBadRequest, "observation names a future control revision")
				return
			}
			if err = backing.ObserveSessionWork(ctx, item.ID, observation); err != nil {
				writeResult(w, nil, err)
				return
			}
		}
		if deviceID != "" && body.Coverage != nil {
			if err = backing.SaveWorkCoverage(ctx, deviceID, body.Coverage); err != nil {
				writeResult(w, nil, err)
				return
			}
		}
	}
	if deviceID == "" {
		writeError(w, http.StatusForbidden, "device credential required")
		return
	}
	// Existing session timers are imported without loading the full transcript.
	if timers, ok := s.store.(store.SessionTimerStore); ok {
		if sessions, err := timers.DeviceSessionTimers(ctx, deviceID, time.Now().UTC()); err == nil {
			for _, timers := range sessions {
				session, err := s.store.GetAgentSessionSummary(ctx, timers.SessionID)
				if err != nil {
					continue
				}
				for _, timer := range timers.Timers {
					if _, err = backing.SaveSessionWork(ctx, sessionwork.Timer(session, timer)); err != nil {
						writeResult(w, nil, err)
						return
					}
				}
			}
		}
	}
	list, err := backing.ListSessionWork(ctx, "", deviceID)
	if err == nil && r.Header.Get("X-Foundry-Native-Work") != "1" {
		// Legacy reconcilers auto-adopt every Claude timer, including observed
		// ones. Do not hand new native definitions to that executor.
		list.Items = slices.DeleteFunc(list.Items, func(item store.SessionWork) bool { return item.Native != nil && item.Kind == "schedule" })
	}
	if err == nil {
		seen := map[string]bool{}
		for _, root := range append(list.StoppedThreads, list.ScopeIDs...) {
			scopes, readErr := backing.SessionWorkSources(ctx, root)
			if readErr != nil {
				writeResult(w, nil, readErr)
				return
			}
			for _, scope := range scopes {
				if seen[scope.ID] || scope.DeviceID != deviceID {
					continue
				}
				workspace, readErr := s.store.GetWorkspace(ctx, scope.WorkspaceID)
				if readErr != nil {
					continue
				}
				seen[scope.ID] = true
				list.Scopes = append(list.Scopes, store.SessionWorkScope{ID: scope.ID, ThreadID: sessionwork.Thread(scope), WorkspaceID: scope.WorkspaceID, DeviceID: scope.DeviceID, WorkspacePath: workspace.LocalPath, NativeSessionID: scope.NativeSessionID})
			}
		}
	}
	if err == nil {
		// Look each workspace up once, outside workMu: a device lists every
		// item it ever reported (thousands), most in a few workspaces.
		paths := map[string]string{}
		for index, item := range list.Items {
			if item.Spec.Cwd != "" {
				continue
			}
			path, known := paths[item.WorkspaceID]
			if !known {
				if workspace, readErr := s.store.GetWorkspace(ctx, item.WorkspaceID); readErr == nil {
					path = workspace.LocalPath
				}
				paths[item.WorkspaceID] = path
			}
			list.Items[index].Spec.Cwd = path
		}
		s.workMu.Lock()
		defer s.workMu.Unlock()
		for index, item := range list.Items {
			if item.Source == "foundry" && item.Kind == "agent" {
				list.Items[index] = s.settleWorkChild(ctx, item)
				continue
			}
			if item.Kind != "schedule" || item.Observation.RunID == "" {
				continue
			}
			list.Items[index], err = s.settleScheduledWork(ctx, item, nil)
			if err != nil {
				break
			}
		}
	}
	writeResult(w, list, err)
}

func (s *Server) handleWorkFire(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	s.workMu.Lock()
	defer s.workMu.Unlock()
	session, err := s.store.GetAgentSessionSummary(ctx, r.PathValue("id"))
	if err != nil || !actorFromContext(ctx).ActsAsDevice(session.DeviceID) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if session.ArchivedAt != "" {
		writeResult(w, nil, store.ErrSessionArchived)
		return
	}
	var body struct {
		ID          string `json:"id"`
		Generation  int64  `json:"generation"`
		ScheduledAt string `json:"scheduledAt"`
	}
	if !decodeJSONRequest(w, r, &body) {
		return
	}
	backing, _ := s.workStore()
	list, err := backing.ListSessionWork(ctx, sessionwork.Thread(session), "")
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	index := slices.IndexFunc(list.Items, func(item store.SessionWork) bool { return item.ID == body.ID && item.SessionID == session.ID })
	if index < 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	item := list.Items[index]
	if item.Kind != "schedule" || body.ScheduledAt == "" {
		writeError(w, http.StatusBadRequest, "scheduled work and scheduledAt required")
		return
	}
	if _, err = time.Parse(time.RFC3339Nano, body.ScheduledAt); err != nil {
		writeError(w, http.StatusBadRequest, "invalid scheduledAt")
		return
	}
	if item.Spec.Target != "new_session" && activeOrBlocked(session.Status) {
		writeError(w, http.StatusConflict, "session busy")
		return
	}
	run, claimed, err := backing.ClaimWorkRun(ctx, item.ID, body.Generation, body.ScheduledAt)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if !claimed {
		writeJSON(w, http.StatusOK, run)
		return
	}
	run.ExecutionSessionID = session.ID
	run.Status = "running"
	if item.Spec.Target == "new_session" {
		var execution store.AgentSession
		execution, err = s.startAgentSession(context.WithValue(ctx, workDispatchContextKey{}, true), store.CreateAgentSessionInput{CreatedByUserID: session.CreatedByUserID, WorkspaceID: session.WorkspaceID, AgentID: session.AgentID, Provider: session.Provider, ProfileID: session.ProfileID, Model: session.Model, ParentSessionID: session.ID, Title: item.Title, Prompt: item.Spec.Prompt, Source: "chat", InputID: scheduledWorkInputID(item, run), ClaudeEffort: session.ClaudeEffort, ClaudePermissionMode: session.ClaudePermissionMode, CodexReasoningEffort: session.CodexReasoningEffort, CodexSandboxMode: session.CodexSandboxMode, CodexApprovalPolicy: session.CodexApprovalPolicy, CodexSpeed: session.CodexSpeed})
		if err == nil {
			run.ExecutionSessionID = execution.ID
		}
	} else {
		_, err = s.sendSessionMessage(ctx, session.ID, store.SendAgentSessionInput{Prompt: item.Spec.Prompt, RequireIdle: true, InputID: scheduledWorkInputID(item, run), TimerFire: &store.AgentSessionTimerFire{ID: item.ID, Origin: "scheduled", Prompt: item.Spec.Prompt, StartedAt: run.StartedAt}})
	}
	if err != nil {
		run.Status = "failed"
		run.Error = err.Error()
		run.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
		_ = backing.FinishWorkRun(ctx, run)
		_ = backing.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "failed", At: run.EndedAt, StartedAt: run.StartedAt, EndedAt: run.EndedAt, RunID: run.ID, ExecutionSessionID: run.ExecutionSessionID, ConfirmedRevision: item.Revision, Error: run.Error})
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err = backing.FinishWorkRun(ctx, run); err != nil {
		writeResult(w, nil, err)
		return
	}
	if err = backing.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "running", At: time.Now().UTC().Format(time.RFC3339Nano), StartedAt: run.StartedAt, RunID: run.ID, ExecutionSessionID: run.ExecutionSessionID, ConfirmedRevision: item.Revision}); err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusAccepted, run)
}

func mustWorkTime(raw string) time.Time { t, _ := time.Parse(time.RFC3339Nano, raw); return t }

type workDispatchContextKey struct{}
