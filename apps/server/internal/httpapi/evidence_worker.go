package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type wsEvidenceResult struct {
	Error               string                       `json:"error,omitempty"`
	TaskID              string                       `json:"taskId"`
	Materials           []store.Material             `json:"materials,omitempty"`
	Candidate           *store.CandidateSnapshot     `json:"candidate,omitempty"`
	Input               *store.VerificationInput     `json:"input,omitempty"`
	Evidence            []store.Evidence             `json:"evidence,omitempty"`
	Verification        *store.Verification          `json:"verification,omitempty"`
	BytesBase64         string                       `json:"bytesBase64,omitempty"`
	ByteSize            int                          `json:"byteSize,omitempty"`
	IntegrationID       string                       `json:"integrationId,omitempty"`
	Status              string                       `json:"status,omitempty"`
	IntegrationSnapshot *store.CandidateSnapshot     `json:"integrationSnapshot,omitempty"`
	Recovered           *wsEvidenceResult            `json:"recovered,omitempty"`
	Total               int                          `json:"total,omitempty"`
	Clarification       *store.ClarificationResponse `json:"clarification,omitempty"`
}

func (s *Server) requestEvidenceWorker(ctx context.Context, issue store.Issue, request map[string]any) (wsEvidenceResult, error) {
	workspace, err := s.store.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return wsEvidenceResult{}, err
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		return wsEvidenceResult{}, fmt.Errorf("worker_offline")
	}
	request["workspaceId"] = issue.WorkspaceID
	request["issueId"] = issue.ID
	request["deviceId"] = workspace.DeviceID
	raw, err := json.Marshal(request)
	if err != nil {
		return wsEvidenceResult{}, err
	}
	result, err := daemonRequest[wsEvidenceResult](ctx, connection, wsEvidenceRequestType, raw)
	if err == nil && result.Error != "" {
		err = fmt.Errorf("%s", result.Error)
	}
	if err == nil && result.TaskID != request["taskId"] {
		err = fmt.Errorf("worker_task_mismatch")
	}
	return result, err
}
