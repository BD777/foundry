package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Each live Worker connection reconciles pending receipts. Recovery is a
// read-only RPC and never sends the original external action a second time.
func (s *Server) recoverEvidenceVerifications(ctx context.Context, workspaceID string) {
	st, ok := s.store.(store.EvidenceStore)
	if !ok {
		return
	}
	unlock := s.lockIssueMutation("evidence-recovery/" + workspaceID)
	defer unlock()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		issues, err := s.store.ListIssues(ctx, workspaceID)
		if err == nil {
			for _, issue := range issues {
				records, err := st.ListEvidenceRecords(ctx, issue.ID, "verification")
				if err != nil {
					continue
				}
				for _, raw := range records {
					var v store.Verification
					if json.Unmarshal(raw, &v) != nil {
						continue
					}
					if v.Status == "queued" {
						contract, err := currentIssueContract(ctx, st, issue)
						if err == nil {
							go s.dispatchVerification(issue, contract, v)
						}
					} else if v.Status == "running" {
						s.recoverEvidenceVerification(ctx, st, issue, v)
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) recoverEvidenceVerification(ctx context.Context, st store.EvidenceStore, issue store.Issue, v store.Verification) {
	reply, err := s.requestEvidenceWorker(ctx, issue, map[string]any{"action": "recover", "taskId": v.ID})
	if err != nil || reply.Status == "running" || reply.Status == "not_started" {
		// not_started may be a dispatch whose socket write is still in flight.
		// Never race it by re-sending the original action.
		if reply.Status != "not_started" || v.StartedAt == nil {
			return
		}
		started, parseErr := time.Parse(time.RFC3339Nano, *v.StartedAt)
		if parseErr != nil || time.Since(started) < 16*time.Minute {
			return
		}
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	switch reply.Status {
	case "settled":
		if reply.Recovered == nil || reply.Recovered.TaskID != v.ID {
			return
		}
		result := *reply.Recovered
		if result.Error != "" {
			err = fmt.Errorf("%s", result.Error)
		} else {
			for _, m := range result.Materials {
				if err = st.RegisterMaterial(ctx, issue.ID, m); err != nil {
					return
				}
			}
			if result.Verification != nil {
				if st.CompleteVerification(ctx, issue.ID, *result.Verification, result.Evidence) == nil {
					s.publishEvidenceUpdate(issue, v.ID, v.Sequence, result.Verification.Status)
				}
				return
			}
			err = fmt.Errorf("retained receipt omitted judgment")
		}
	case "unknown", "not_started":
		err = fmt.Errorf("task_outcome_unknown: Worker has no durable completion; inspect retained output before a new verification")
	default:
		return
	}
	v.Status = "failed"
	now := time.Now().UTC().Format(time.RFC3339Nano)
	v.FinishedAt = &now
	v.Error = &store.VerificationError{Code: "verification_recovery_error", Message: err.Error(), Retryable: false}
	_ = st.CompleteVerification(ctx, issue.ID, v, nil)
	s.publishEvidenceUpdate(issue, v.ID, v.Sequence, v.Status)
}
