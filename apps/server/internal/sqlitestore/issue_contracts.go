package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) contractByRevision(ctx context.Context, issueID string, revision int) (store.IssueContract, error) {
	return getJSON[store.IssueContract](ctx, s.conn(), `SELECT payload_json FROM evidence_records WHERE issue_id=? AND kind='contract' AND sequence=?`, issueID, revision)
}
func (s *Store) createInitialContract(ctx context.Context, issue *store.Issue) error {
	content := store.ContractContent{Goal: store.RichContent{Text: issue.SourceInput, Media: []store.ReferenceMedia{}}, InScope: []string{}, OutOfScope: []string{}, Constraints: []string{}, Criteria: []store.AcceptanceCriterion{}}
	contract := store.IssueContract{SchemaVersion: 1, ID: evidenceID("ctr"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: store.ActorRef{Kind: "system", ID: "foundry", DisplayName: "Foundry"}, Revision: 1, Origin: "user", Goal: content.Goal, InScope: content.InScope, OutOfScope: content.OutOfScope, Constraints: content.Constraints, Criteria: content.Criteria, Status: "draft", ContentDigest: evidenceDigest(content)}
	issue.ContractState = "draft"
	issue.DraftContractRevision = &contract.Revision
	return s.insertEvidenceRecord(ctx, *issue, "contract", contract.ID, 1, contract)
}

func (s *Store) contractDigest(ctx context.Context, issue store.Issue, content store.ContractContent) (string, error) {
	references := append([]store.ReferenceMedia{}, content.Goal.Media...)
	ids := []string{}
	for _, c := range content.Criteria {
		references = append(references, c.Rubric.Media...)
		if c.Checker != nil {
			config := c.Checker.Configuration
			if config.CheckerBundleMaterialID != nil {
				ids = append(ids, *config.CheckerBundleMaterialID)
			}
			ids = append(ids, config.FixtureMaterialIDs...)
			if config.BodyMaterialID != nil {
				ids = append(ids, *config.BodyMaterialID)
			}
		}
	}
	for _, r := range references {
		ids = append(ids, r.MaterialID)
	}
	materials := map[string]string{}
	for _, id := range ids {
		raw, err := s.GetEvidenceRecord(ctx, issue.ID, "material", id)
		if err != nil {
			return "", fmt.Errorf("reference material unavailable or belongs to another issue")
		}
		var material store.Material
		if err = json.Unmarshal(raw, &material); err != nil {
			return "", err
		}
		if material.Availability != "available" {
			return "", fmt.Errorf("reference material %s is not available", id)
		}
		materials[id] = material.Digest
	}
	if len(materials) == 0 {
		return evidenceDigest(content), nil
	}
	return evidenceDigest(map[string]any{"content": content, "materials": materials}), nil
}

func (s *Store) resolveCheckerDigests(ctx context.Context, issue store.Issue, content *store.ContractContent) error {
	for i := range content.Criteria {
		checker := content.Criteria[i].Checker
		if checker == nil {
			continue
		}
		config := checker.Configuration
		if config.Kind == "command" {
			if config.CheckerBundleMaterialID == nil {
				return fmt.Errorf("checker_bundle_required")
			}
			bundle, err := evidenceGet[store.Material](ctx, s, issue.ID, "material", *config.CheckerBundleMaterialID)
			if err != nil {
				return err
			}
			fixtures := []string{}
			for _, id := range config.FixtureMaterialIDs {
				m, err := evidenceGet[store.Material](ctx, s, issue.ID, "material", id)
				if err != nil {
					return err
				}
				fixtures = append(fixtures, m.Digest)
			}
			checker.DefinitionDigest = evidenceDigest(map[string]any{"configuration": config, "bundleDigest": bundle.Digest, "fixtureDigests": fixtures, "timeoutMs": checker.TimeoutMs})
		} else if config.Kind == "project_command" {
			// The command and the sealed candidate are the whole definition:
			// no bundle, fixtures or body material exist.
			checker.DefinitionDigest = evidenceDigest(map[string]any{"configuration": config, "timeoutMs": checker.TimeoutMs})
		} else {
			bodyDigest := ""
			if config.BodyMaterialID != nil {
				m, err := evidenceGet[store.Material](ctx, s, issue.ID, "material", *config.BodyMaterialID)
				if err != nil {
					return err
				}
				bodyDigest = m.Digest
			}
			checker.DefinitionDigest = evidenceDigest(map[string]any{"configuration": config, "bodyDigest": bodyDigest, "timeoutMs": checker.TimeoutMs})
		}
	}
	return nil
}

func (s *Store) CreateContract(ctx context.Context, issueID string, input store.ContractDraftInput, actor store.ActorRef, requestID string) (store.IssueContract, error) {
	return s.createContractDraft(ctx, issueID, input, actor, requestID, "user")
}

func (s *Store) createContractDraft(ctx context.Context, issueID string, input store.ContractDraftInput, actor store.ActorRef, requestID, origin string) (store.IssueContract, error) {
	var result store.IssueContract
	if !store.IsHumanActor(actor) && !(origin == "agent_proposal" && actor.Kind == "agent") {
		return result, fmt.Errorf("user_action_required")
	}
	raw, _ := json.Marshal(input.Content)
	if err := store.ValidateEvidenceJSON("ContractContent", raw); err != nil {
		return result, err
	}
	err := s.evidenceRequest(ctx, issueID+"/contracts", requestID, []any{input, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		if issue.Status == "accepted" || issue.Status == "abandoned" {
			return nil, fmt.Errorf("terminal issue retains its historical contract")
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "contract")
		if err != nil {
			return nil, err
		}
		if sequence > 1 && (input.BaseRevision == nil || *input.BaseRevision != sequence-1) {
			return nil, fmt.Errorf("contract_revision_conflict")
		}
		if sequence == 1 && input.BaseRevision != nil {
			return nil, fmt.Errorf("contract_revision_conflict")
		}
		if sequence > 1 && (input.ChangeReason == nil || strings.TrimSpace(*input.ChangeReason) == "") {
			return nil, fmt.Errorf("change_reason_required")
		}
		if err = tx.resolveCheckerDigests(ctx, issue, &input.Content); err != nil {
			return nil, err
		}
		digest, err := tx.contractDigest(ctx, issue, input.Content)
		if err != nil {
			return nil, err
		}
		c := store.IssueContract{SchemaVersion: 1, ID: evidenceID("ctr"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: actor, Revision: sequence, BasedOnRevision: input.BaseRevision, Origin: origin, Goal: input.Content.Goal, InScope: input.Content.InScope, OutOfScope: input.Content.OutOfScope, Constraints: input.Content.Constraints, Criteria: input.Content.Criteria, ChangeReason: input.ChangeReason, ContentDigest: digest, Status: "draft"}
		if issue.DraftContractRevision != nil {
			previous, err := tx.contractByRevision(ctx, issue.ID, *issue.DraftContractRevision)
			if err != nil {
				return nil, err
			}
			previous.Status = "superseded"
			if err = tx.updateEvidenceProjection(ctx, previous.ID, previous); err != nil {
				return nil, err
			}
		}
		if err = tx.insertEvidenceRecord(ctx, issue, "contract", c.ID, sequence, c); err != nil {
			return nil, err
		}
		issue.DraftContractRevision = &sequence
		issue.ContractState = "draft"
		if issue.CurrentContractRevision != nil {
			issue.ContractState = "amendment_pending"
		}
		issue.CurrentReviewSnapshotID = nil
		issue.VerificationSummary = nil
		if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return nil, err
		}
		err = tx.auditEvidence(ctx, issue, actor, requestID, "contract_proposed", "contract", c.ID, c.ContentDigest, "")
		return c, err
	}, &result)
	return result, err
}

func (s *Store) ConfirmContract(ctx context.Context, issueID string, revision int, digest string, actor store.ActorRef, requestID string) (store.IssueContract, error) {
	var result store.IssueContract
	if !store.IsHumanActor(actor) {
		return result, fmt.Errorf("user_action_required")
	}
	err := s.evidenceRequest(ctx, issueID+"/confirm", requestID, []any{revision, digest, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		c, err := tx.contractByRevision(ctx, issue.ID, revision)
		if err != nil {
			return nil, err
		}
		if issue.DraftContractRevision == nil || *issue.DraftContractRevision != revision || c.Status != "draft" || c.ContentDigest != digest {
			return nil, fmt.Errorf("contract_revision_conflict: review exact draft before confirming")
		}
		if issue.Status == "accepted" || issue.Status == "abandoned" {
			return nil, fmt.Errorf("terminal issue")
		}
		// Confirming a draft can requeue a blocked/verifying issue to pending.
		// A soft-removed device must never gain new dispatchable work this way.
		if err := tx.assertWorkspaceDeviceNotRemoved(ctx, issue.WorkspaceID); err != nil {
			return nil, err
		}
		if issue.Run != nil && issue.Run.Status == "running" {
			return nil, fmt.Errorf("execution_in_flight: let current tools settle before confirming")
		}
		if err = store.ValidateContractContent(store.ContractContentOf(c), true); err != nil {
			return nil, err
		}
		actual, err := tx.contractDigest(ctx, issue, store.ContractContentOf(c))
		if err != nil {
			return nil, err
		}
		if actual != digest {
			return nil, fmt.Errorf("contract_material_changed")
		}
		if issue.CurrentContractRevision != nil {
			old, err := tx.contractByRevision(ctx, issue.ID, *issue.CurrentContractRevision)
			if err != nil {
				return nil, err
			}
			old.Status = "superseded"
			if err = tx.updateEvidenceProjection(ctx, old.ID, old); err != nil {
				return nil, err
			}
		}
		c.Status = "confirmed"
		c.Confirmation = &store.ContractConfirmation{Actor: actor, At: evidenceNow(), ContentDigest: digest}
		if err = tx.updateEvidenceProjection(ctx, c.ID, c); err != nil {
			return nil, err
		}
		issue.ContractState = "confirmed"
		issue.CurrentContractRevision = &revision
		issue.DraftContractRevision = nil
		issue.CurrentReviewSnapshotID = nil
		issue.VerificationSummary = nil
		issue.AcceptanceCriteria = []string{}
		issue.InferredTask = ""
		for _, criterion := range c.Criteria {
			issue.AcceptanceCriteria = append(issue.AcceptanceCriteria, criterion.Statement)
		}
		// A newly confirmed standard supersedes any finished candidate: the issue
		// goes back to implementation instead of waiting on a review whose
		// candidate was built for the previous revision.
		if (issue.Status == "blocked" || issue.Status == "verifying") && (issue.Run == nil || issue.Run.Status != "running") {
			issue.Status = "pending"
			issue.BlockedReason = nil
		}
		if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return nil, err
		}
		err = tx.auditEvidence(ctx, issue, actor, requestID, "contract_confirmed", "contract", c.ID, c.ContentDigest, "")
		return c, err
	}, &result)
	return result, err
}

func (s *Store) DiscardContract(ctx context.Context, issueID string, revision int, reason string, actor store.ActorRef, requestID string) (store.IssueContract, error) {
	var result store.IssueContract
	if !store.IsHumanActor(actor) {
		return result, fmt.Errorf("user_action_required")
	}
	if strings.TrimSpace(reason) == "" {
		return result, fmt.Errorf("discard reason required")
	}
	err := s.evidenceRequest(ctx, issueID+"/discard", requestID, []any{revision, reason, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		c, err := tx.contractByRevision(ctx, issue.ID, revision)
		if err != nil {
			return nil, err
		}
		if issue.DraftContractRevision == nil || *issue.DraftContractRevision != revision || c.Status != "draft" {
			return nil, fmt.Errorf("contract_revision_conflict")
		}
		c.Status = "discarded"
		if err = tx.updateEvidenceProjection(ctx, c.ID, c); err != nil {
			return nil, err
		}
		issue.DraftContractRevision = nil
		issue.ContractState = "draft"
		if issue.CurrentContractRevision != nil {
			issue.ContractState = "confirmed"
		}
		if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return nil, err
		}
		err = tx.auditEvidence(ctx, issue, actor, requestID, "contract_discarded", "contract", c.ID, c.ContentDigest, reason)
		return c, err
	}, &result)
	return result, err
}
