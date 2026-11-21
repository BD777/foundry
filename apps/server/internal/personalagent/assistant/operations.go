package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// DispatchItem is dispatch_item: one durable step of an item's work,
// captured once per item, intent revision and stepKey, which
// drainOperations hands to a session. It is the item-tied path; a helper
// that needs no item starts through the generic create_session. control
// resolves a session the caller names, refusing one it may not control.
func (s *Service) DispatchItem(ctx context.Context, scope Scope, args map[string]json.RawMessage, control func(sessionID string) (store.AgentSession, error)) (store.PersonalAgentOperation, error) {
	var spec struct {
		ReplaceOwner    bool   `json:"replaceOwner"`
		ReadOnly        bool   `json:"readOnly,omitempty"`
		ItemID          string `json:"itemId"`
		IntentRevision  int64  `json:"intentRevision"`
		StepKey         string `json:"stepKey"`
		WorkspaceID     string `json:"workspaceId"`
		SessionID       string `json:"sessionId"`
		ExecutionChoice string `json:"executionChoice"`
		Prompt          string `json:"prompt"`
	}
	if err := DecodeArgs(args, &spec); err != nil {
		return store.PersonalAgentOperation{}, err
	}
	if strings.TrimSpace(spec.StepKey) == "" || len(spec.StepKey) > 100 || strings.TrimSpace(spec.Prompt) == "" || len(spec.Prompt) > 128*1024 {
		return store.PersonalAgentOperation{}, invalid("a stable stepKey and bounded prompt are required")
	}
	spec.ExecutionChoice = strings.TrimSpace(spec.ExecutionChoice)
	if spec.ExecutionChoice == "" {
		spec.ExecutionChoice = "default"
	}
	if !scope.reaches(spec.WorkspaceID) {
		return store.PersonalAgentOperation{}, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusForbidden,
			"not allowed: this assistant's permissions do not include project %s; the person adds it in the assistant's settings → Permissions.", spec.WorkspaceID)
	}
	if err := s.runs.ValidateExecutorChoice(ctx, scope.Agent, spec.WorkspaceID, spec.ExecutionChoice); err != nil {
		return store.PersonalAgentOperation{}, err
	}
	// Explicit continuation must reference a session the caller may control.
	if spec.ReplaceOwner && spec.SessionID == "" {
		return store.PersonalAgentOperation{}, invalid("replaceOwner requires the previous owner sessionId")
	}
	if spec.SessionID != "" {
		target, err := control(spec.SessionID)
		if err != nil {
			return store.PersonalAgentOperation{}, err
		}
		if target.WorkspaceID != spec.WorkspaceID {
			return store.PersonalAgentOperation{}, invalid("session belongs to a different workspace")
		}
	}
	hash, err := flow.Fingerprint(spec)
	if err != nil {
		return store.PersonalAgentOperation{}, err
	}
	id := flow.Key("paop", scope.Agent.UserID, spec.ItemID, strconv.FormatInt(spec.IntentRevision, 10), spec.StepKey)
	return s.store.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: id, UserID: scope.Agent.UserID, AssistantID: scope.Agent.ID, ItemID: spec.ItemID, IntentRevision: spec.IntentRevision, StepKey: spec.StepKey, WorkspaceID: spec.WorkspaceID, SourceSessionID: scope.SessionID, SourceInputID: scope.Turn.ID, TargetSessionID: spec.SessionID, ExecutionChoice: spec.ExecutionChoice, ReplaceOwner: spec.ReplaceOwner, ReadOnly: spec.ReadOnly, InputID: flow.InputID(id), Prompt: spec.Prompt, RequestHash: hash})
}

// drainOperations performs no inference. Each dispatch has a
// durable instruction and lease; it must not delay receipt processing on
// another device.
func (s *Service) drainOperations(ctx context.Context) {
	ops, err := s.store.DuePersonalAgentOperations(ctx, time.Now().UTC().Format(time.RFC3339Nano), 20)
	if err != nil {
		return
	}
	for _, op := range ops {
		if ctx.Err() != nil {
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		s.DeliverOperation(runCtx, op)
		cancel()
	}
}

// DeliverOperation moves one dispatched operation on: reconciles its
// receipt, or hands it to its session (a new one, or the owner it names)
// through the same start/send path any assistant helper uses. The durable
// operation stays the outbox: its lease, intent revision and input id are
// what make a retry idempotent.
func (s *Service) DeliverOperation(ctx context.Context, op store.PersonalAgentOperation) {
	save := func(status, reason, session string) {
		op.Status, op.Reason, op.SessionID = status, reason, session
		op.LeaseUntil = time.Now().Add(10 * time.Second).UTC().Format(time.RFC3339Nano)
		if saved, e := s.store.SavePersonalAgentOperation(ctx, op); e == nil {
			op = saved
			if session != "" {
				s.linkOperation(ctx, saved, session)
			}
		}
	}
	if receipt, err := s.store.WorkRunInputSession(ctx, op.InputID); err == nil {
		session, err := s.store.GetAgentSessionSummary(ctx, receipt)
		if err != nil || session.CreatedByUserID != op.UserID || session.WorkspaceID != op.WorkspaceID {
			return
		}
		if session.Input.ID != op.InputID {
			if op.Status != "delivered" {
				save("delivered", "owner_input_changed_requires_evidence", receipt)
			}
			save("review", "owner_input_changed_requires_evidence", receipt)
			return
		}
		if agent, e := s.store.GetAssistant(ctx, op.AssistantID); e == nil {
			s.RecordTask(ctx, agent, op.SourceSessionID, session, "")
		}
		if op.Status == "delivered" && session.Input.ID == op.InputID {
			switch session.Status {
			case "completed":
				save("review", "execution_completed_requires_evidence", receipt)
			case "failed":
				save("failed", "execution_failed", receipt)
			case "canceled":
				save("cancelled", "execution_cancelled", receipt)
			default:
				save("delivered", "", receipt)
			}
		} else {
			save("delivered", "", receipt)
		}
		_ = s.store.BindPersonalAgentRunSnapshot(ctx, op.AssistantID, flow.Key("parun", op.UserID, op.ID), receipt)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		return
	}
	if op.Status == "unknown" || op.Status == "delivered" {
		return
	}
	op.Status, op.LeaseUntil = "dispatching", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	claimed, err := s.store.SavePersonalAgentOperation(ctx, op)
	if err != nil {
		// Recheck intent inside the transactional claim. No stale plan executes.
		if errors.Is(err, store.ErrPersonalAgentRevision) || errors.Is(err, store.ErrNotFound) || strings.Contains(err.Error(), "does not authorize") {
			save("cancelled", "intent_changed", "")
		}
		if strings.Contains(err.Error(), "dependency_pending") {
			save("waiting", "dependency_pending", "")
		}
		return
	}
	op = claimed
	agent, err := s.store.GetAssistant(ctx, op.AssistantID)
	if err != nil {
		return
	}
	if agent.State == store.PersonalAgentStopped {
		save("waiting", "assistant_paused", "")
		return
	}
	// The package may have changed since the step was captured.
	if pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID); err != nil {
		return
	} else if !(permission.Access{Applicable: true, Agent: agent, Package: pkg}).WorkspaceAllowed(op.WorkspaceID) {
		save("waiting", "workspace_not_permitted", "")
		return
	}
	// Avoid adding a competing writer when an existing task already owns it.
	item, err := s.store.GetPersonalAgentItem(ctx, op.AssistantID, op.ItemID)
	if err != nil {
		return
	}
	targetID := op.TargetSessionID
	// A read-only step is no competing writer: it goes where it was sent.
	if item.Plan != nil && !op.ReadOnly {
		for _, ref := range item.Plan.WorkRefs {
			if ref.Kind == "session" && ref.Relation == "executing" && ref.WorkspaceID == op.WorkspaceID {
				if targetID != "" && targetID != ref.ID {
					save("waiting", "existing_owner_conflict", "")
					return
				}
				targetID = ref.ID
			}
		}
	}
	var target store.AgentSession
	if targetID != "" {
		target, err = s.store.GetAgentSessionSummary(ctx, targetID)
		if err != nil || target.CreatedByUserID != op.UserID || target.WorkspaceID != op.WorkspaceID {
			save("waiting", "owner_permission_required", "")
			return
		}
		if store.IsActiveSessionStatus(target.Status) {
			save("waiting", "existing_owner_busy", "")
			return
		}
	}
	// A session continued keeps its own account and model (§f-4); only a
	// new helper runs on the executor's choice.
	var snapshot store.PersonalAgentRunSnapshot
	if targetID != "" && !op.ReplaceOwner {
		snapshot, err = s.runs.PinSession(ctx, agent, op.ID, "executor", target)
	} else {
		snapshot, err = s.runs.PinExecutor(ctx, agent, op.ID, "executor", op.WorkspaceID, op.ExecutionChoice)
		if err == nil {
			err = s.runs.CheckPinned(ctx, snapshot)
		}
	}
	if err != nil {
		save("waiting", "execution_configuration_unavailable", "")
		return
	}
	op.SnapshotID = snapshot.ID
	if op, err = s.store.SavePersonalAgentOperation(ctx, op); err != nil {
		return
	}
	if !s.devices.Connected(snapshot.DeviceID) {
		save("waiting", "device_offline", "")
		return
	}
	// The assistant's own prompt is the brief. Foundry adds no item,
	// approval or goal preamble of its own.
	prompt := op.Prompt
	if op.ReadOnly {
		prompt += "\n\nThe assistant dispatched this step as read-only; it started without waiting for other sessions that may be changing this workspace."
	}
	var session store.AgentSession
	if targetID != "" && !op.ReplaceOwner {
		if _, _, err = s.AdmitSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: op.UserID, WorkspaceID: op.WorkspaceID, ParentSessionID: op.SourceSessionID, Source: store.SessionSourceAgent}); err != nil {
			save("waiting", "execution_policy_limit", "")
			return
		}
		if target, e := s.store.GetAgentSessionSummary(ctx, targetID); e == nil {
			s.RecordTask(ctx, agent, op.SourceSessionID, target, "")
		}
		session, err = s.sessions.Send(ctx, targetID, store.SendAgentSessionInput{ExecutionBudget: run.ExecutionBudget(snapshot), Prompt: prompt, InputID: op.InputID, SentBySessionID: op.SourceSessionID, RequireIdle: true, PersonalAgentOperationID: op.ID, PersonalAgentOperationRevision: op.Revision}, nil)
	} else {
		// A new helper starts exactly as create_session starts one: the
		// generic admission, scope and executor default, with the
		// operation's durable run pinned for its budget and receipt.
		input := store.CreateAgentSessionInput{
			CreatedByUserID: op.UserID, WorkspaceID: op.WorkspaceID,
			Prompt: prompt, InputID: op.InputID, Title: textcut.Prefix(item.Text, 160),
			Source: store.SessionSourceAgent, ParentSessionID: op.SourceSessionID,
			PersonalAgentOperationID: op.ID, PersonalAgentOperationRevision: op.Revision,
			ExecutionBudget: run.ExecutionBudget(snapshot),
		}
		if _, err = s.ApplyHelperDefaults(ctx, &input, &snapshot); err == nil {
			err = s.sessions.ResolveDevice(ctx, &input)
		}
		if err == nil {
			session, err = s.sessions.CreateAndDispatch(ctx, input, sessions.StartOptions{Reconcile: true})
		}
	}
	if session.ID != "" {
		queued := op.QueuedNoticeAt != ""
		save("delivered", "", session.ID)
		if queued {
			s.noticeOperation(ctx, agent, op, s.sayTask(ctx, agent, "opStarted", op.StepKey, s.personTime(ctx, agent, op.WaitingSince), session.ID))
		}
	} else if err != nil {
		reason := "dispatch_unavailable"
		var busy *store.WorkspaceWriterBusyError
		if errors.As(err, &busy) || strings.Contains(err.Error(), "workspace_writer_busy") {
			reason = "workspace_writer_busy"
			s.writerBusy(ctx, agent, &op, busy, time.Now())
		}
		save("waiting", reason, "")
	}
}

// OperationQueuedNoticeAfter is how long a write step waits for its
// workspace's writer before its dispatching session is told.
var OperationQueuedNoticeAfter = 5 * time.Minute

// writerBusy records on op that it waits for busy (nil when unknown), and
// tells its dispatching session once it has waited
// OperationQueuedNoticeAfter.
func (s *Service) writerBusy(ctx context.Context, agent store.PersonalAgent, op *store.PersonalAgentOperation, busy *store.WorkspaceWriterBusyError, now time.Time) {
	if op.WaitingSince == "" {
		op.WaitingSince = now.UTC().Format(time.RFC3339Nano)
	}
	if busy != nil {
		op.BusySessionID, op.BusySince = busy.SessionID, busy.Since
	}
	since, err := time.Parse(time.RFC3339Nano, op.WaitingSince)
	if op.QueuedNoticeAt != "" || err != nil || now.Sub(since) < OperationQueuedNoticeAfter {
		return
	}
	project := op.WorkspaceID
	if workspace, err := s.store.GetWorkspace(ctx, op.WorkspaceID); err == nil && workspace.Name != "" {
		project = fmt.Sprintf("%q (%s)", workspace.Name, workspace.ID)
	}
	var line string
	if op.BusySessionID != "" {
		line = s.sayTask(ctx, agent, "opQueued", op.StepKey, s.personTime(ctx, agent, op.WaitingSince), project, op.BusySessionID, s.personTime(ctx, agent, op.BusySince))
	} else {
		line = s.sayTask(ctx, agent, "opQueuedUnsettled", op.StepKey, s.personTime(ctx, agent, op.WaitingSince), project)
	}
	op.QueuedNoticeAt = now.UTC().Format(time.RFC3339Nano)
	s.noticeOperation(ctx, agent, *op, line)
}

// noticeOperation tells the session that dispatched op one fact about it,
// gathered with the task notices of that conversation.
func (s *Service) noticeOperation(ctx context.Context, agent store.PersonalAgent, op store.PersonalAgentOperation, line string) {
	if agent.State != store.PersonalAgentActive || op.SourceSessionID == "" {
		return
	}
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	s.notices.add(op.SourceSessionID, language, line, time.Now(), func(text string) {
		current, err := s.store.GetAssistant(context.Background(), agent.ID)
		if err != nil || current.State != store.PersonalAgentActive {
			return
		}
		s.tell(context.Background(), op.SourceSessionID, store.NoticeKindOperation, text)
	})
}

// personTime is an RFC 3339 time in the person's zone.
func (s *Service) personTime(ctx context.Context, agent store.PersonalAgent, at string) string {
	return zonedTime(at, s.PersonLocation(ctx, agent))
}

func (s *Service) linkOperation(ctx context.Context, op store.PersonalAgentOperation, sessionID string) {
	item, err := s.store.GetPersonalAgentItem(ctx, op.AssistantID, op.ItemID)
	if err != nil || item.IntentRevision != op.IntentRevision || item.Plan == nil {
		return
	}
	linked := false
	for _, ref := range item.Plan.WorkRefs {
		if ref.Kind == "session" && ref.ID == sessionID {
			linked = true
		}
	}
	if tasks, e := s.store.ListPersonalAgentTasks(ctx, op.AssistantID, nil); e != nil {
		log.Printf("personal agent %s: list tasks for item %s: %v", op.AssistantID, item.ID, e)
	} else {
		for _, task := range tasks {
			if task.SessionID == sessionID {
				if e := s.setTaskItem(ctx, task, item.ID); e != nil {
					log.Printf("personal agent %s: tie task %s to item %s: %v", op.AssistantID, task.ID, item.ID, e)
				}
				break
			}
		}
	}
	// The tie above saved the item again: edit its current copy.
	item, err = s.store.GetPersonalAgentItem(ctx, op.AssistantID, op.ItemID)
	if err != nil || item.IntentRevision != op.IntentRevision || item.Plan == nil {
		return
	}
	previous := *item.Plan
	previous.WorkRefs = append([]store.PersonalAgentWorkReference(nil), item.Plan.WorkRefs...)
	if op.ReplaceOwner {
		for i, ref := range item.Plan.WorkRefs {
			if ref.Kind == "session" && ref.ID == op.TargetSessionID && ref.Relation == "executing" {
				item.Plan.WorkRefs[i].Relation = "observing"
			}
		}
	}
	if !linked {
		item.Plan.WorkRefs = withSessionRelation(item.Plan.WorkRefs, sessionID, op.WorkspaceID, "executing")
	}
	switch op.Status {
	case "review":
		item.Plan.Progress = "review"
	case "failed", "cancelled":
		item.Plan.Progress = "waiting"
	default:
		item.Plan.Progress = "working"
	}
	if reflect.DeepEqual(previous, *item.Plan) {
		return
	}
	_, _ = s.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item) // next reconciliation retries a concurrent edit
}

// withSessionRelation sets the relation of a session's reference on an item's
// plan, adding the reference when the item has none for it.
func withSessionRelation(refs []store.PersonalAgentWorkReference, sessionID, workspaceID, relation string) []store.PersonalAgentWorkReference {
	for i, ref := range refs {
		if ref.Kind == "session" && ref.ID == sessionID {
			refs[i].Relation = relation
			return refs
		}
	}
	return append(refs, store.PersonalAgentWorkReference{Kind: "session", ID: sessionID, WorkspaceID: workspaceID, Relation: relation})
}
