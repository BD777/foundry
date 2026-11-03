package issues

import (
	"context"
	"errors"
	"log"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// CreateOptions: RequestID keys a creation sent again; InitializeGit is the
// person's agreement to set up Git in a workspace without it.
type CreateOptions struct {
	RequestID     string
	InitializeGit bool
}

// Created is a new Issue, whether Git was set up for it, and why its first
// clarification did not start when it did not (the person starts it with
// their next message).
type Created struct {
	Issue          store.Issue
	GitInitialized bool
	ClarifyError   error
}

// firstClarificationReason is why the first clarification may revise the
// draft.
const firstClarificationReason = "Clarification started from the original input; execution is not authorized."

// Create makes the Issue as the actor's, once its workspace has Git, and
// starts clarifying it with its request when its Agent can (Claude, Codex).
func (s *Service) Create(ctx context.Context, by Actor, input store.CreateIssueInput, options CreateOptions) (Created, error) {
	initialized, err := s.devices.Git(ctx, input.WorkspaceID, options.InitializeGit)
	if err != nil {
		return Created{}, err
	}
	input.CreatedByUserID = by.UserID
	issue, err := s.store.CreateIssueIdempotent(ctx, input, options.RequestID)
	if err != nil {
		return Created{}, refused(http.StatusBadRequest, err)
	}
	s.events.Created(issue)
	created := Created{Issue: issue, GitInitialized: initialized}
	if issue.DraftContractRevision == nil || (issue.Runtime != "claude" && issue.Runtime != "codex") {
		return created, nil
	}
	draft, err := s.store.ContractByRevision(ctx, issue.ID, *issue.DraftContractRevision)
	if err == nil {
		issue, err = s.Clarify(ctx, by, store.AskClarificationInput{
			IssueID: issue.ID, Revision: draft.Revision, ContentDigest: draft.ContentDigest,
			Message: issue.SourceInput, ChangeReason: firstClarificationReason,
		}, "start-"+issue.ID)
	}
	if err != nil {
		created.ClarifyError = err
		return created, nil
	}
	created.Issue = issue
	return created, nil
}

// Clarify sends the person's message about the draft they saw (the input's
// revision and digest) to the Issue's clarification session. It answers
// once the message is recorded and queued; the Agent's reply settles later.
func (s *Service) Clarify(ctx context.Context, by Actor, input store.AskClarificationInput, requestID string) (store.Issue, error) {
	input.Via = by.Via
	return s.queueClarification(ctx, input.IssueID, func(issueID string) (store.Issue, store.AgentSession, error) {
		input.IssueID = issueID
		return s.store.AskClarification(ctx, input, by.ActorRef, requestID)
	})
}

// RetryClarification sends the person's latest message to the clarification
// session again after it failed to answer.
func (s *Service) RetryClarification(ctx context.Context, by Actor, issueID, requestID string) (store.Issue, error) {
	return s.queueClarification(ctx, issueID, func(issueID string) (store.Issue, store.AgentSession, error) {
		return s.store.RetryClarification(ctx, issueID, by.ActorRef, requestID)
	})
}

// queueClarification queues a message of the Issue's clarification session
// once the workspace's device can run it, and hands it to the device.
func (s *Service) queueClarification(ctx context.Context, issueID string, queue func(issueID string) (store.Issue, store.AgentSession, error)) (store.Issue, error) {
	issue, err := s.store.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	workspace, err := s.store.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return store.Issue{}, err
	}
	if !s.devices.Connected(workspace.DeviceID) {
		return store.Issue{}, &sessions.Refusal{Status: http.StatusConflict, Err: errors.New("worker_offline: the workspace's device is not connected")}
	}
	unlock := s.Lock(issue.ID)
	defer unlock()
	updated, session, err := queue(issue.ID)
	if err != nil {
		return store.Issue{}, conflict(err)
	}
	s.events.Updated(updated)
	// A replayed request may find its input already sent or answered.
	current, err := s.store.GetAgentSessionSummary(ctx, session.ID)
	if err == nil && current.Status == "queued" && current.Input.ID == session.Input.ID {
		if err := s.devices.Dispatch(current); err != nil {
			log.Printf("dispatch clarification session %s: %v", session.ID, err)
		}
	}
	return updated, nil
}

// AskStatus answers a person's question about where the Issue stands, in
// its conversation.
func (s *Service) AskStatus(ctx context.Context, issueID, message, requestID string) (store.Issue, error) {
	issue, unlock, err := s.locked(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	defer unlock()
	if issue, err = s.store.RecordIssueStatusQuestion(ctx, issue.ID, message, requestID); err != nil {
		return store.Issue{}, conflict(err)
	}
	s.events.Updated(issue)
	return issue, nil
}

// SaveDraft saves a new draft of the Issue's contract.
func (s *Service) SaveDraft(ctx context.Context, by Actor, issueID string, input store.ContractDraftInput, requestID string) (store.IssueContract, error) {
	return s.decideContract(ctx, issueID, func(issueID string) (store.IssueContract, error) {
		return s.store.CreateContract(ctx, issueID, input, by.ActorRef, requestID)
	})
}

// Confirm confirms the draft at revision as the person saw it (digest); the
// Issue may run.
func (s *Service) Confirm(ctx context.Context, by Actor, issueID string, revision int, digest, requestID string) (store.IssueContract, error) {
	return s.decideContract(ctx, issueID, func(issueID string) (store.IssueContract, error) {
		return s.store.ConfirmContract(ctx, issueID, revision, digest, by.ActorRef, requestID)
	})
}

// Discard drops the draft at revision, for reason.
func (s *Service) Discard(ctx context.Context, by Actor, issueID string, revision int, reason, requestID string) (store.IssueContract, error) {
	return s.decideContract(ctx, issueID, func(issueID string) (store.IssueContract, error) {
		return s.store.DiscardContract(ctx, issueID, revision, reason, by.ActorRef, requestID)
	})
}

func (s *Service) decideContract(ctx context.Context, issueID string, decide func(issueID string) (store.IssueContract, error)) (store.IssueContract, error) {
	issue, unlock, err := s.locked(ctx, issueID)
	if err != nil {
		return store.IssueContract{}, err
	}
	defer unlock()
	contract, err := decide(issue.ID)
	if err != nil {
		return store.IssueContract{}, conflict(err)
	}
	s.events.EvidenceChanged(issue, contract.ID, contract.Revision, string(contract.Status))
	if current, err := s.store.GetIssue(ctx, issue.ID); err == nil {
		s.events.Updated(current)
	}
	if contract.Status == "confirmed" {
		go s.devices.ClaimReady()
	}
	return contract, nil
}

// Answer records the person's answer to the question the Issue waits on;
// the Issue continues in its candidate.
func (s *Service) Answer(ctx context.Context, by Actor, issueID, questionID, answer string) (store.Issue, error) {
	issue, unlock, err := s.locked(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	defer unlock()
	if issue, err = s.store.AnswerIssueQuestion(ctx, issue.ID, questionID, answer, by.Via); err != nil {
		return store.Issue{}, conflict(err)
	}
	s.events.Updated(issue)
	go s.devices.ClaimReady()
	return issue, nil
}

// Continue queues the Issue to continue in its candidate with the person's
// message (feedback, a retry), once its device found the candidate may
// change. expectedRunID, when given, is the execution the person saw.
func (s *Service) Continue(ctx context.Context, by Actor, issueID, message, expectedRunID string) (store.Issue, error) {
	issue, unlock, err := s.locked(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	defer unlock()
	if !issue.Allows(store.IssueEventContinued) {
		return store.Issue{}, conflict(errors.New("Issue cannot be retried in its current state"))
	}
	if err := s.checkRetry(ctx, issue); err != nil {
		return store.Issue{}, err
	}
	if issue, err = s.store.RequestIssueChanges(ctx, issue.ID, message, expectedRunID, by.Via); err != nil {
		return store.Issue{}, conflict(err)
	}
	s.events.Updated(issue)
	go s.devices.ClaimReady()
	return issue, nil
}

// Abandon closes the Issue without integrating it; its candidate and
// conversation are kept. expectedRunID is the execution the person saw.
func (s *Service) Abandon(ctx context.Context, by Actor, issueID, expectedRunID string) (store.Issue, error) {
	issue, unlock, err := s.locked(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	defer unlock()
	if issue.Status != "abandoned" {
		if !issue.Allows(store.IssueEventAbandoned) {
			return store.Issue{}, conflict(errors.New("Stop execution before abandoning an unfinished Issue"))
		}
		// It may not abandon a partially applied integration.
		if err := s.checkRetry(ctx, issue); err != nil {
			return store.Issue{}, err
		}
	}
	if issue, err = s.store.AbandonIssue(ctx, issue.ID, expectedRunID); err != nil {
		return store.Issue{}, conflict(err)
	}
	s.events.Updated(issue)
	return issue, nil
}

// checkRetry asks the device about a candidate the Issue already has.
func (s *Service) checkRetry(ctx context.Context, issue store.Issue) error {
	if issue.Run == nil || issue.Run.EnvironmentID == "" {
		return nil
	}
	return conflict(s.devices.CheckRetry(ctx, issue))
}

// Ask records what the Issue's running execution (sessionID) asks the
// person; the Issue waits on it once the execution's turn ends.
func (s *Service) Ask(ctx context.Context, sessionID string, question store.IssueQuestion) (store.Issue, error) {
	issue, err := s.store.AskIssueQuestion(ctx, sessionID, question)
	if err != nil {
		return store.Issue{}, conflict(err)
	}
	s.events.Updated(issue)
	return issue, nil
}
