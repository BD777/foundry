package sqlitestore

import (
	"context"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Exact historical placeholders are not observable user requirements. Preserve
// the original Issue fields, but never promote these strings into a contract.
func legacyContractContent(issue store.Issue) store.ContractContent {
	placeholders := map[string]bool{
		"One primary acceptance artifact is produced.":               true,
		"Worker events are visible on the issue.":                    true,
		"Accept and request-changes remain explicit review actions.": true,
	}
	text := issue.SourceInput
	if strings.TrimSpace(text) == "" {
		text = issue.Title
	}
	requirements := []string{}
	for _, statement := range issue.AcceptanceCriteria {
		if !placeholders[statement] && strings.TrimSpace(statement) != "" {
			requirements = append(requirements, statement)
		}
	}
	if len(requirements) > 0 {
		text += "\n\nUnconfirmed legacy conditions (define rubric and evidence before confirmation):\n- " + strings.Join(requirements, "\n- ")
	}
	// Legacy records do not contain rubric, binding policy or evidence requirements.
	// Keep their text visible without inventing a fully specified Criterion.
	return store.ContractContent{
		Goal:    store.RichContent{Text: text, Media: []store.ReferenceMedia{}},
		InScope: []string{}, OutOfScope: []string{}, Constraints: []string{},
		Criteria: []store.AcceptanceCriterion{},
	}
}

func (s *Store) ImportLegacyContract(ctx context.Context, issueID string, actor store.ActorRef, requestID string) (store.IssueContract, error) {
	var result store.IssueContract
	if !store.IsHumanActor(actor) {
		return result, fmt.Errorf("user_action_required")
	}
	err := s.evidenceRequest(ctx, issueID+"/import-legacy", requestID, actor, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		if issue.ContractState != "legacy_unconfirmed" || issue.Status == "accepted" || issue.Status == "abandoned" {
			return nil, fmt.Errorf("legacy_import_not_applicable")
		}
		reason := "Import historical text as an unconfirmed draft; do not promote old checks or reports"
		return tx.createContractDraft(ctx, issue.ID, store.ContractDraftInput{
			Content: legacyContractContent(issue), ChangeReason: &reason,
		}, actor, requestID+"/draft", "legacy_import")
	}, &result)
	return result, err
}
