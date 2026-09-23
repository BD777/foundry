package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) ReplayClarification(ctx context.Context, issueID string, revision int, digest, message, changeReason string, actor store.ActorRef, requestID string) (store.Issue, bool, error) {
	var issue store.Issue
	var oldDigest, response string
	err := s.conn().QueryRowContext(ctx, `SELECT request_digest,response_json FROM evidence_requests WHERE scope=? AND request_id=?`, issueID+"/clarification", requestID).Scan(&oldDigest, &response)
	if errors.Is(err, sql.ErrNoRows) {
		return issue, false, nil
	}
	if err != nil {
		return issue, false, err
	}
	if oldDigest != evidenceDigest([]any{revision, digest, message, changeReason, actor}) {
		return issue, true, fmt.Errorf("idempotency_conflict")
	}
	err = json.Unmarshal([]byte(response), &issue)
	return issue, true, err
}

// Uses Issue conversation + IssueContract; there is no separate questionnaire.
func (s *Store) RecordClarification(ctx context.Context, issueID string, revision int, digest, message, changeReason string, response store.ClarificationResponse, actor store.ActorRef, requestID string) (store.Issue, error) {
	var result store.Issue
	if !store.IsHumanActor(actor) || strings.TrimSpace(message) == "" || strings.TrimSpace(response.Message) == "" {
		return result, fmt.Errorf("human_clarification_required")
	}
	err := s.evidenceRequest(ctx, issueID+"/clarification", requestID, []any{revision, digest, message, changeReason, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		if issue.Status == "accepted" || issue.Status == "abandoned" || (issue.Run != nil && issue.Run.Status == "running") {
			return nil, fmt.Errorf("clarification_not_available")
		}
		draft, err := tx.contractByRevision(ctx, issue.ID, revision)
		if err != nil {
			return nil, err
		}
		if issue.DraftContractRevision == nil || *issue.DraftContractRevision != revision || draft.Status != "draft" || draft.ContentDigest != digest {
			return nil, fmt.Errorf("clarification_draft_changed")
		}
		if _, err = tx.GetEvidenceRecord(ctx, issue.ID, "material", response.RawOutputMaterialID); err != nil {
			return nil, err
		}
		agent := store.ActorRef{Kind: "agent", ID: "contract_clarifier", DisplayName: "Contract clarification", SessionID: response.SessionID}
		// A conversational restatement is not a new contract revision.
		if response.ProposedContent != nil {
			if err := tx.resolveCheckerDigests(ctx, issue, response.ProposedContent); err != nil {
				return nil, err
			}
			proposedDigest, err := tx.contractDigest(ctx, issue, *response.ProposedContent)
			if err != nil {
				return nil, err
			}
			if proposedDigest == draft.ContentDigest {
				response.ProposedContent = nil
			}
		}
		if response.ProposedContent != nil {
			if strings.TrimSpace(changeReason) == "" {
				return nil, fmt.Errorf("change_reason_required")
			}
			_, err = tx.createContractDraft(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &revision, Content: *response.ProposedContent, ChangeReason: &changeReason}, agent, requestID+"/proposal", "agent_proposal")
			if err != nil {
				return nil, err
			}
			issue, err = tx.GetIssue(ctx, issue.ID)
			if err != nil {
				return nil, err
			}
		}
		now := evidenceNow()
		issue.Messages = append(issue.Messages,
			store.IssueConversationMessage{ID: evidenceID("clarify"), Role: "user", Text: message, CreatedAt: now},
			store.IssueConversationMessage{ID: evidenceID("clarify"), Role: "assistant", Text: response.Message, CreatedAt: now})
		if issue.Run == nil {
			issue.Status = "blocked"
			issue.BlockedReason = &store.IssueBlockedReason{Kind: "needs_input", Message: "Answer the clarification or explicitly confirm the saved contract proposal."}
		}
		if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return nil, err
		}
		result = issue
		return issue, nil
	}, &result)
	return result, err
}
