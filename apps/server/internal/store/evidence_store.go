package store

import (
	"context"
	"encoding/json"
)

// Methods are kept separate from the legacy Store interface for migration.
type EvidenceStore interface {
	RecordIssueStatusQuestion(ctx context.Context, issueID, message, requestID string) (Issue, error)
	CreateIssueIdempotent(ctx context.Context, input CreateIssueInput, requestID string) (Issue, error)
	RecordClarification(ctx context.Context, issueID string, revision int, digest, message, changeReason string, response ClarificationResponse, actor ActorRef, requestID string) (Issue, error)
	ReplayClarification(ctx context.Context, issueID string, revision int, digest, message, changeReason string, actor ActorRef, requestID string) (Issue, bool, error)
	ListEvidenceRecords(ctx context.Context, issueID, kind string) ([]json.RawMessage, error)
	GetEvidenceRecord(ctx context.Context, issueID, kind, id string) (json.RawMessage, error)
	CreateContract(ctx context.Context, issueID string, input ContractDraftInput, actor ActorRef, requestID string) (IssueContract, error)
	ImportLegacyContract(ctx context.Context, issueID string, actor ActorRef, requestID string) (IssueContract, error)
	ConfirmContract(ctx context.Context, issueID string, revision int, digest string, actor ActorRef, requestID string) (IssueContract, error)
	DiscardContract(ctx context.Context, issueID string, revision int, reason string, actor ActorRef, requestID string) (IssueContract, error)
	CurrentReview(ctx context.Context, issueID string) (ReviewSnapshot, error)
	RecordReviewObservation(ctx context.Context, issueID, candidateID string, blockers []ReviewBlocker) error
	RegisterMaterial(ctx context.Context, issueID string, material Material) error
	RegisterExportEvidence(ctx context.Context, issueID string, evidence Evidence) error
	RegisterCandidate(ctx context.Context, issueID string, candidate CandidateSnapshot, input VerificationInput) error
	RegisterAlignedCandidate(ctx context.Context, issueID, previousSnapshotID string, candidate CandidateSnapshot, input VerificationInput) error
	RequestVerification(ctx context.Context, issueID string, revision int, snapshotID string, criterionID string, actor ActorRef, requestID string) (Verification, error)
	StartVerification(ctx context.Context, issueID, verificationID string) (Verification, error)
	MarkVerificationInterrupted(ctx context.Context, issueID, verificationID string) error
	CompleteVerification(ctx context.Context, issueID string, verification Verification, evidence []Evidence) error
	CreateHumanAssessment(ctx context.Context, issueID string, input HumanAssessmentInput, actor ActorRef, requestID string) (HumanAssessment, error)
	RegisterHumanEvidence(ctx context.Context, issueID string, input HumanEvidenceInput, actor ActorRef, requestID string) (Evidence, error)
	ApproveReview(ctx context.Context, issueID, reviewID, digest string, actor ActorRef, requestID string, rationale *RichContent) (AcceptanceDecision, error)
	RegisterIntegrationSnapshot(ctx context.Context, issueID, decisionID string, snapshot CandidateSnapshot) error
	FinishAcceptance(ctx context.Context, issueID, decisionID, integrationID string, invalidReason string) (AcceptanceDecision, error)
}

type ClarificationResponse struct {
	Message             string           `json:"message"`
	ProposedContent     *ContractContent `json:"proposedContent,omitempty"`
	SessionID           *string          `json:"sessionId,omitempty"`
	RawOutputMaterialID string           `json:"rawOutputMaterialId"`
}

// Only a journal-aware Worker may resolve a partially applied baseline.
// All other review changes invalidate an outstanding approval.
func SameReviewJudgments(current, approved ReviewSnapshot) bool {
	if current.ContractRevision != approved.ContractRevision || current.CandidateSnapshotID != approved.CandidateSnapshotID || len(current.CriterionResults) != len(approved.CriterionResults) {
		return false
	}
	for i, before := range approved.CriterionResults {
		after := current.CriterionResults[i]
		if before.CriterionID != after.CriterionID || before.EffectiveVerdict != after.EffectiveVerdict || before.Authority != after.Authority ||
			!sameEvidenceID(before.VerificationID, after.VerificationID) || !sameEvidenceID(before.HumanAssessmentID, after.HumanAssessmentID) {
			return false
		}
		a, _ := json.Marshal(before.EvidenceIDs)
		b, _ := json.Marshal(after.EvidenceIDs)
		if string(a) != string(b) {
			return false
		}
	}
	for _, blocker := range current.BlockingReasons {
		if blocker.Code != "baseline_changed" {
			return false
		}
	}
	return true
}

func sameEvidenceID(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

type HumanAssessmentInput struct {
	VerificationID    string             `json:"verificationId"`
	Verdict           string             `json:"verdict"`
	Rationale         RichContent        `json:"rationale"`
	EvidenceCitations []EvidenceCitation `json:"evidenceCitations"`
}
type HumanEvidenceInput struct {
	ExpectedContractRevision  int             `json:"expectedContractRevision"`
	VerificationInputID       string          `json:"verificationInputId"`
	Title                     string          `json:"title"`
	Description               string          `json:"description"`
	Claims                    []EvidenceClaim `json:"claims"`
	MaterialIDs               []string        `json:"materialIds"`
	Attestation               string          `json:"attestation"`
	CollectionInputMaterialID string          `json:"collectionInputMaterialId"`
}

func ContractContentOf(c IssueContract) ContractContent {
	return ContractContent{Goal: c.Goal, InScope: c.InScope, OutOfScope: c.OutOfScope, Constraints: c.Constraints, Criteria: c.Criteria}
}
