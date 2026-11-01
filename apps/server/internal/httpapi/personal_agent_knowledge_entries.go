package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) knowledgeVaultForRequest(r *http.Request) (store.KnowledgeVault, error) {
	return s.store.GetKnowledgeVault(r.Context(), s.personFrom(r).ID, r.PathValue("vault"))
}
func (s *Server) handleKnowledgeEntries(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if _, err = s.knowledgeWorkspace(r.Context(), v.UserID, v); err != nil {
		writeResult(w, nil, err)
		return
	}
	entries, err := s.store.ListKnowledgeEntries(r.Context(), v.UserID, v.ID)
	writeResult(w, entries, err)
}
func (s *Server) handleKnowledgeEntryRead(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	doc, err := s.readKnowledgeEntry(r.Context(), v, r.PathValue("entry"), true)
	writeResult(w, doc, err)
}
func (s *Server) readKnowledgeEntry(ctx context.Context, v store.KnowledgeVault, id string, includeExpired bool) (*store.KnowledgeDocument, error) {
	entry, err := s.store.GetKnowledgeEntry(ctx, v.UserID, v.ID, id)
	if err != nil {
		return nil, err
	}
	if entry.State != "active" || v.State != "active" || entry.Epoch != v.Epoch {
		return nil, invalid("knowledge is unavailable or revoked")
	}
	if !includeExpired && entry.ExpiresAt != "" {
		if expiry, err := time.Parse(time.RFC3339, entry.ExpiresAt); err != nil || !time.Now().Before(expiry) {
			return nil, invalid("knowledge is expired")
		}
	}
	workspace, err := s.knowledgeWorkspace(ctx, v.UserID, v)
	if err != nil {
		return nil, err
	}
	result, err := s.hub.knowledgeCommand(ctx, workspace, store.KnowledgeCommand{WorkspaceID: v.WorkspaceID, RootPath: v.RootPath, VaultID: v.ID, Epoch: v.Epoch, Action: "read", DocumentID: id, OperationID: flow.Key("kread", v.ID, id)})
	if err != nil {
		return nil, err
	}
	if result.Document == nil || result.Document.Deleted || result.Document.Hash != entry.Hash || result.Document.Revision != entry.Revision || result.Document.SourceRef != entry.SourceRef || result.Document.SourceVersion != entry.SourceVersion || result.Document.ExpiresAt != entry.ExpiresAt {
		return nil, invalid("knowledge source changed; refresh and review its authority")
	}
	// A forget may have raced this device read. Do not release the old body.
	current, err := s.store.GetKnowledgeEntry(ctx, v.UserID, v.ID, id)
	if err != nil {
		return nil, err
	}
	if current.State != "active" || current.Hash != entry.Hash || current.Revision != entry.Revision {
		return nil, invalid("knowledge changed during retrieval")
	}
	return result.Document, nil
}
func (s *Server) handleKnowledgeEntryWrite(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if _, err = s.knowledgeWorkspace(r.Context(), v.UserID, v); err != nil {
		writeResult(w, nil, err)
		return
	}
	var input struct {
		RequestID        string `json:"requestId"`
		EntryID          string `json:"entryId"`
		Action           string `json:"action"`
		Title            string `json:"title"`
		Body             string `json:"body"`
		ExpectedRevision int64  `json:"expectedRevision"`
		ExpectedHash     string `json:"expectedHash"`
		ExpectedRawHash  string `json:"expectedRawHash"`
		SourceRef        string `json:"sourceRef"`
		SourceVersion    string `json:"sourceVersion"`
		ExpiresAt        string `json:"expiresAt"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Action == "" {
		input.Action = "write"
	}
	if strings.TrimSpace(input.RequestID) == "" || len(input.RequestID) > 200 || !utf8.ValidString(input.Body) || len(input.Body) > 128*1024 || len(input.Title) > 200 || len(input.SourceRef) > 2000 || len(input.SourceVersion) > 1000 || input.ExpectedRevision < 0 || (input.Action != "write" && input.Action != "adopt" && input.Action != "forget") {
		writeResult(w, nil, invalid("invalid knowledge request"))
		return
	}
	if (input.Action == "write" || input.Action == "adopt") && (strings.TrimSpace(input.Body) == "" || strings.TrimSpace(input.Title) == "") {
		writeResult(w, nil, invalid("a title and source text are required"))
		return
	}
	if input.ExpiresAt != "" {
		if _, err := time.Parse(time.RFC3339, input.ExpiresAt); err != nil {
			writeResult(w, nil, invalid("expiry requires an RFC3339 timestamp"))
			return
		}
	}
	if input.Action == "adopt" && (input.EntryID == "" || !maintenanceHash(input.ExpectedRawHash)) {
		writeResult(w, nil, invalid("adoption requires the reviewed raw source hash"))
		return
	}
	if input.EntryID == "" {
		input.EntryID = flow.Key("knowledge", v.ID, input.RequestID)
	}
	if !knowledgeIdentifier(input.EntryID) {
		writeResult(w, nil, invalid("invalid knowledge identity"))
		return
	}
	if input.Action == "adopt" {
		input.SourceRef = "user-review:" + input.RequestID
		input.SourceVersion = input.ExpectedRawHash
	}
	if input.SourceRef == "" && input.Action == "write" {
		input.SourceRef = "user-input:" + input.RequestID
	}
	fingerprint, err := flow.Fingerprint(input)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	job, err := s.store.CaptureKnowledgeMutation(r.Context(), store.KnowledgeMutation{ID: flow.Key("kwrite", v.UserID, v.ID, input.RequestID), UserID: v.UserID, VaultID: v.ID, EntryID: input.EntryID, Epoch: v.Epoch, Action: input.Action, ExpectedRevision: input.ExpectedRevision, ExpectedHash: input.ExpectedHash, ExpectedRawHash: input.ExpectedRawHash, Title: input.Title, Body: input.Body, SourceRef: input.SourceRef, SourceVersion: input.SourceVersion, ExpiresAt: input.ExpiresAt, RequestHash: fingerprint})
	writeResultWithStatus(w, http.StatusAccepted, job, err)
}
func knowledgeIdentifier(id string) bool {
	if len(id) == 0 || len(id) > 160 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func (s *Server) drainKnowledgeMutations(ctx context.Context) {
	jobs, err := s.store.DueKnowledgeMutations(ctx, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return
	}
	for _, job := range jobs {
		if ctx.Err() != nil {
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		s.applyKnowledgeMutation(runCtx, job)
		cancel()
	}
}
func (s *Server) applyKnowledgeMutation(ctx context.Context, job store.KnowledgeMutation) {
	job.Status, job.LeaseUntil = "writing", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	claimed, err := s.store.SaveKnowledgeMutation(ctx, job)
	if err != nil {
		return
	}
	job = claimed
	wait := func(reason string) {
		job.Status, job.Reason, job.LeaseUntil = "waiting", reason, time.Now().Add(15*time.Second).UTC().Format(time.RFC3339Nano)
		_, _ = s.store.SaveKnowledgeMutation(ctx, job)
	}
	v, err := s.store.GetKnowledgeVault(ctx, job.UserID, job.VaultID)
	if err != nil {
		wait("knowledge_location_unavailable")
		return
	}
	if (v.State != "active" && !(job.Action == "forget" && (v.State == "migrating" || v.State == "frozen"))) || v.Epoch != job.Epoch {
		wait("knowledge_authority_not_ready")
		return
	}
	workspace, err := s.knowledgeWorkspace(ctx, job.UserID, v)
	if job.Action == "forget" {
		workspace, err = s.knowledgeEraseWorkspace(ctx, job.UserID, v)
	}
	if err != nil {
		wait(knowledgeWaitingReason(err))
		return
	}
	command := store.KnowledgeCommand{MinimumRevision: job.ExpectedRevision, WorkspaceID: v.WorkspaceID, RootPath: v.RootPath, VaultID: v.ID, Epoch: v.Epoch, Action: job.Action, OperationID: job.ID, DocumentID: job.EntryID, ExpectedRevision: &job.ExpectedRevision, ExpectedHash: job.ExpectedHash, ExpectedRawHash: job.ExpectedRawHash, Body: job.Body, SourceRef: job.SourceRef, SourceVersion: job.SourceVersion, ExpiresAt: job.ExpiresAt}
	if job.Action == "forget" {
		read := command
		read.Action = "read"
		current, err := s.hub.knowledgeCommand(ctx, workspace, read)
		if err != nil && strings.Contains(err.Error(), "external_edit:") {
			read.Action = "inspect"
			inspected, e := s.hub.knowledgeCommand(ctx, workspace, read)
			if e != nil || inspected.Review == nil {
				wait("knowledge_source_review_unavailable")
				return
			}
			command.ExpectedRawHash = inspected.Review.RawHash
		} else if err != nil && !strings.Contains(err.Error(), "not_found:") {
			wait(knowledgeWaitingReason(err))
			return
		}
		revision, hash := int64(0), ""
		if command.ExpectedRawHash != "" {
			revision, hash = job.ExpectedRevision, job.ExpectedHash
		}
		if current.Document != nil {
			revision, hash = current.Document.Revision, current.Document.Hash
		}
		command.ExpectedRevision, command.ExpectedHash = &revision, hash
	}
	result, err := s.hub.knowledgeCommand(ctx, workspace, command)
	if err != nil {
		wait(knowledgeWaitingReason(err))
		return
	}
	if result.Document == nil {
		wait("knowledge_receipt_missing")
		return
	}
	expected := sha256.Sum256([]byte(command.Body))
	if job.Action == "forget" {
		expected = sha256.Sum256(nil)
	}
	if result.Document.Hash != hex.EncodeToString(expected[:]) {
		wait("knowledge_receipt_mismatch")
		return
	}
	if err = s.store.CompleteKnowledgeMutation(ctx, job, *result.Document); err != nil && !errors.Is(err, store.ErrPersonalAgentRevision) {
		wait("knowledge_receipt_unavailable")
	}
}

func (s *Server) handleKnowledgeMutations(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.store.ListKnowledgeMutations(r.Context(), s.personFrom(r).ID)
	writeResult(w, jobs, err)
}

func (s *Server) handleKnowledgeSourceInspect(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	entry, err := s.store.GetKnowledgeEntry(r.Context(), v.UserID, v.ID, r.PathValue("entry"))
	if err != nil || entry.State != "active" || v.State != "active" {
		writeResult(w, nil, invalid("source unavailable or revoked"))
		return
	}
	workspace, err := s.knowledgeWorkspace(r.Context(), v.UserID, v)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	reply, err := s.hub.knowledgeCommand(r.Context(), workspace, store.KnowledgeCommand{WorkspaceID: v.WorkspaceID, RootPath: v.RootPath, VaultID: v.ID, Epoch: v.Epoch, Action: "inspect", DocumentID: entry.ID, OperationID: flow.Key("kreview", v.ID, entry.ID)})
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	current, err := s.store.GetKnowledgeEntry(r.Context(), v.UserID, v.ID, entry.ID)
	if err != nil || current.State != "active" || current.Revision != entry.Revision {
		writeResult(w, nil, invalid("source changed during review"))
		return
	}
	writeResult(w, reply.Review, nil)
}

func (s *Server) handleRepairKnowledgeIndex(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	workspace, err := s.knowledgeWorkspace(r.Context(), v.UserID, v)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input struct {
		Epoch     int64 `json:"epoch"`
		Confirmed bool  `json:"confirmed"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !input.Confirmed || input.Epoch != v.Epoch {
		writeResult(w, nil, invalid("confirm rebuilding the index of the current authority"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	reply, err := s.hub.knowledgeCommand(ctx, workspace, store.KnowledgeCommand{WorkspaceID: v.WorkspaceID, RootPath: v.RootPath, VaultID: v.ID, Epoch: v.Epoch, Action: "list", OperationID: flow.Key("repair-index", v.ID)})
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if reply.VaultID != v.ID || reply.Epoch != v.Epoch || reply.State != "active" {
		writeResult(w, nil, invalid("source authority changed"))
		return
	}
	if err = s.store.ReconcileKnowledgeIndex(ctx, v.UserID, v.ID, v.Epoch, reply.Documents); err != nil {
		writeResult(w, nil, err)
		return
	}
	entries, err := s.store.ListKnowledgeEntries(ctx, v.UserID, v.ID)
	writeResult(w, entries, err)
}
