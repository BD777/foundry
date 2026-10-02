package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue is clarified in one conversation with an Agent: the Issue's
// clarification session (role issue_clarification). Every message the person
// sends about the draft is a new input of that session, so the Agent keeps
// its context between turns; its reply settles the message later. The
// conversation and the contract stay on the Issue; there is no questionnaire.

var (
	errClarificationUnavailable = errors.New("clarification_not_available")
	errClarificationDraftMoved  = errors.New("clarification_draft_changed")
	errClarificationBusy        = errors.New("clarification_busy: the Agent is still answering the previous message")
)

// clarificationContextLimit bounds the conversation re-sent to a session that
// lost its native context.
const clarificationContextLimit = 60

type clarificationRequest struct {
	Issue   store.Issue        `json:"issue"`
	Session store.AgentSession `json:"session"`
}

func (s *Store) AskClarification(ctx context.Context, input store.AskClarificationInput, actor store.ActorRef, requestID string) (store.Issue, store.AgentSession, error) {
	var result clarificationRequest
	message := strings.TrimSpace(input.Message)
	if !store.IsHumanActor(actor) || message == "" || len(message) > 16000 || strings.TrimSpace(input.ChangeReason) == "" {
		return store.Issue{}, store.AgentSession{}, fmt.Errorf("human_clarification_required")
	}
	err := s.evidenceRequest(ctx, input.IssueID+"/clarification", requestID, []any{input.Revision, input.ContentDigest, message, input.ChangeReason, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, input.IssueID)
		if err != nil {
			return nil, err
		}
		if err := clarificationAvailable(issue); err != nil {
			return nil, err
		}
		draft, err := tx.contractByRevision(ctx, issue.ID, input.Revision)
		if err != nil {
			return nil, err
		}
		if issue.DraftContractRevision == nil || *issue.DraftContractRevision != input.Revision || draft.Status != "draft" || draft.ContentDigest != input.ContentDigest {
			return nil, errClarificationDraftMoved
		}
		if issue.Clarification != nil && issue.Clarification.Status == "replying" {
			return nil, errClarificationBusy
		}
		turns := 0
		for _, m := range issue.Messages {
			if strings.HasPrefix(m.ID, "clarify_") {
				turns++
			}
		}
		if turns >= clarificationContextLimit {
			return nil, fmt.Errorf("clarification_context_full: edit the current contract draft directly")
		}
		now := time.Now().UTC()
		messageID := evidenceID("clarify")
		issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: messageID, Role: "user", Text: message, CreatedAt: evidenceNow(), Via: input.Via})
		session, err := tx.queueClarificationInput(ctx, issue, message, now)
		if err != nil {
			return nil, err
		}
		issue.Clarification = &store.IssueClarification{
			SessionID: session.ID, Status: "replying", InputID: session.Input.ID, MessageID: messageID,
			Revision: input.Revision, ContentDigest: input.ContentDigest, ChangeReason: input.ChangeReason,
		}
		if err := tx.saveIssue(ctx, issue, time.Time{}, now); err != nil {
			return nil, err
		}
		return clarificationRequest{Issue: issue, Session: session}, nil
	}, &result)
	return result.Issue, result.Session, err
}

func (s *Store) RetryClarification(ctx context.Context, issueID string, actor store.ActorRef, requestID string) (store.Issue, store.AgentSession, error) {
	var result clarificationRequest
	if !store.IsHumanActor(actor) {
		return store.Issue{}, store.AgentSession{}, fmt.Errorf("human_clarification_required")
	}
	err := s.evidenceRequest(ctx, issueID+"/clarification-retry", requestID, actor, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		if err := clarificationAvailable(issue); err != nil {
			return nil, err
		}
		pending := issue.Clarification
		if pending == nil || pending.Status != "failed" {
			return nil, fmt.Errorf("clarification_retry_unavailable: nothing failed to answer")
		}
		if issue.DraftContractRevision == nil || *issue.DraftContractRevision != pending.Revision {
			return nil, errClarificationDraftMoved
		}
		var message string
		for _, m := range issue.Messages {
			if m.ID == pending.MessageID {
				message = m.Text
			}
		}
		if message == "" {
			return nil, fmt.Errorf("clarification_retry_unavailable: the message is gone")
		}
		now := time.Now().UTC()
		session, err := tx.queueClarificationInput(ctx, issue, message, now)
		if err != nil {
			return nil, err
		}
		pending.Status, pending.Error, pending.SessionID, pending.InputID = "replying", "", session.ID, session.Input.ID
		if err := tx.saveIssue(ctx, issue, time.Time{}, now); err != nil {
			return nil, err
		}
		return clarificationRequest{Issue: issue, Session: session}, nil
	}, &result)
	return result.Issue, result.Session, err
}

func clarificationAvailable(issue store.Issue) error {
	if issue.Status == "accepted" || issue.Status == "abandoned" || (issue.Run != nil && issue.Run.Status == "running") ||
		(issue.Runtime != "claude" && issue.Runtime != "codex") {
		return errClarificationUnavailable
	}
	return nil
}

// queueClarificationInput makes the message the next input of the Issue's
// clarification session, creating the session on first use. The session
// follows the Issue's current Agent choice; another runtime or profile
// starts a new native session.
func (s *Store) queueClarificationInput(ctx context.Context, issue store.Issue, message string, now time.Time) (store.AgentSession, error) {
	workspace, err := s.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return store.AgentSession{}, err
	}
	if err := s.assertDeviceNotRemoved(ctx, workspace.DeviceID); err != nil {
		return store.AgentSession{}, err
	}
	next := store.AgentSession{
		CreatedByUserID: issue.CreatedByUserID,
		WorkspaceID:     issue.WorkspaceID,
		DeviceID:        workspace.DeviceID,
		Provider:        issue.Runtime,
		ProfileID:       issue.ProfileID,
		Source:          "issue",
		Role:            store.AgentSessionRoleIssueClarification,
		IssueID:         issue.ID,
		Title:           titleFromInput("Clarify " + issue.ShortID + " " + issue.Title),
		Prompt:          fmt.Sprintf("Clarify the goal and completion criteria of %s with the person.", issue.ShortID),
		CreatedLabel:    "just now",
		Events:          []store.AgentSessionEvent{},
	}
	if issue.Clarification != nil {
		existing, err := s.GetAgentSessionSummary(ctx, issue.Clarification.SessionID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return store.AgentSession{}, err
		}
		if err == nil {
			if isActiveAgentSession(existing.Status) {
				return store.AgentSession{}, errClarificationBusy
			}
			nativeSessionID := existing.NativeSessionID
			if !compatibleAgentSessionProfile(existing, next) || existing.DeviceID != next.DeviceID {
				nativeSessionID = ""
			}
			createdBy, created := existing.CreatedByUserID, existing.CreatedLabel
			next.ID, next.ThreadID, next.NativeSessionID = existing.ID, existing.ThreadID, nativeSessionID
			next.CreatedByUserID, next.CreatedLabel, next.StartedAt = createdBy, created, ""
		}
	}
	createdAt := time.Time{}
	if next.ID == "" {
		next.ID = fmt.Sprintf("sess_%d", now.UnixNano())
		next.ThreadID = next.ID
		createdAt = now
	}
	next.Model, next.ClaudeEffort, next.CodexReasoningEffort, next.CodexSpeed = issue.Model, issue.ClaudeEffort, issue.CodexReasoningEffort, issue.CodexSpeed
	next.Input = store.SessionInput{ID: newSessionInputID(now), Prompt: message}
	next.Status, next.UpdatedLabel = "queued", "queued"
	if err := s.saveAgentSession(ctx, next, createdAt, now); err != nil {
		return store.AgentSession{}, err
	}
	if err := s.recordSessionInput(ctx, next.ID, next.Input, now); err != nil {
		return store.AgentSession{}, err
	}
	return next, nil
}

func (s *Store) ClarificationTurn(ctx context.Context, issueID string) (store.ClarificationTurn, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return store.ClarificationTurn{}, err
	}
	pending := issue.Clarification
	if pending == nil {
		return store.ClarificationTurn{}, errClarificationUnavailable
	}
	draft, err := s.contractByRevision(ctx, issue.ID, pending.Revision)
	if err != nil {
		return store.ClarificationTurn{}, err
	}
	turn := store.ClarificationTurn{Draft: draft, Messages: []store.ChatRecapMessage{}}
	for _, m := range issue.Messages {
		switch {
		case m.ID == pending.MessageID:
			turn.Message = m.Text
		case strings.HasPrefix(m.ID, "clarify_") && turn.Message == "":
			turn.Messages = append(turn.Messages, store.ChatRecapMessage{Role: m.Role, Text: m.Text})
		}
	}
	return turn, nil
}

func (s *Store) AnswerClarification(ctx context.Context, session store.AgentSession, response *store.ClarificationResponse) (store.Issue, error) {
	var result store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, session.IssueID)
		if err != nil {
			return err
		}
		pending := issue.Clarification
		// Only the input the person is waiting on settles; an answer to an
		// earlier input (a late report after a retry) changes nothing.
		if pending == nil || pending.SessionID != session.ID || pending.InputID != session.Input.ID || pending.Status == "answered" {
			result = issue
			return nil
		}
		if response == nil || strings.TrimSpace(response.Message) == "" {
			pending.Status, pending.Error = "failed", strings.TrimSpace(session.Error)
			if pending.Error == "" {
				pending.Error = "The Agent ended without a reply."
			}
			if err := tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
				return err
			}
			result = issue
			return nil
		}
		reply := strings.TrimSpace(response.Message)
		if response.ProposedContent != nil {
			reply, err = tx.recordClarificationProposal(ctx, &issue, session, *response.ProposedContent, reply)
			if err != nil {
				return err
			}
		}
		issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: evidenceID("clarify"), Role: "assistant", Text: reply, CreatedAt: evidenceNow()})
		issue.Clarification.Status, issue.Clarification.Error = "answered", ""
		if issue.Run == nil && (issue.Status == "pending" || issue.Status == "blocked") {
			if err := issue.Apply(store.IssueEventClarificationReplied, &store.IssueBlockedReason{Kind: "needs_input", Message: "Answer the clarification or explicitly confirm the saved contract proposal."}); err != nil {
				return err
			}
		}
		if err := tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return err
		}
		result = issue
		return nil
	})
	return result, err
}

// recordClarificationProposal saves the reply's proposal as a new draft of
// the revision the person asked about. A conversational restatement is not
// a new revision; a draft that moved meanwhile keeps the person's version
// and the reply says the proposal was not saved.
func (s *Store) recordClarificationProposal(ctx context.Context, issue *store.Issue, session store.AgentSession, content store.ContractContent, reply string) (string, error) {
	pending := issue.Clarification
	draft, err := s.contractByRevision(ctx, issue.ID, pending.Revision)
	if err != nil {
		return "", err
	}
	if issue.DraftContractRevision == nil || *issue.DraftContractRevision != pending.Revision || draft.Status != "draft" || draft.ContentDigest != pending.ContentDigest {
		return reply + "\n\n（标准在我回复期间被修改过，这版草案没有保存；请看看最新的标准，需要的话再告诉我。）", nil
	}
	if err := s.resolveCheckerDigests(ctx, *issue, &content); err != nil {
		return "", err
	}
	proposedDigest, err := s.contractDigest(ctx, *issue, content)
	if err != nil {
		return "", err
	}
	if proposedDigest == draft.ContentDigest {
		return reply, nil
	}
	sessionID := session.ID
	agent := store.ActorRef{Kind: "agent", ID: "contract_clarifier", DisplayName: "Contract clarification", SessionID: &sessionID}
	reason := pending.ChangeReason
	if _, err := s.createContractDraft(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &pending.Revision, Content: content, ChangeReason: &reason}, agent, session.Input.ID+"/proposal", "agent_proposal"); err != nil {
		return "", err
	}
	updated, err := s.GetIssue(ctx, issue.ID)
	if err != nil {
		return "", err
	}
	*issue = updated
	return reply, nil
}
