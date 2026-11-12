package httpapi

import (
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's knowledge (personalagent/knowledge) as the web's
// /api/personal-agent/knowledge routes and the read_knowledge tool reach
// it. Every route is personOnly; the service authorizes each file access.

func (s *Server) knowledgeVaultForRequest(r *http.Request) (store.KnowledgeVault, error) {
	return s.store.GetKnowledgeVault(r.Context(), s.personFrom(r).ID, r.PathValue("vault"))
}

func (s *Server) handleKnowledgeVaults(w http.ResponseWriter, r *http.Request) {
	vaults, err := s.store.ListKnowledgeVaults(r.Context(), s.personFrom(r).ID)
	writeResult(w, vaults, err)
}

func (s *Server) handleCreateKnowledgeVault(w http.ResponseWriter, r *http.Request) {
	var input knowledge.VaultRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	vault, existing, err := s.knowledge.CreateVault(r.Context(), s.personFrom(r).ID, input)
	if existing {
		writeResult(w, vault, err)
		return
	}
	writeResultWithStatus(w, http.StatusAccepted, vault, err)
}

func (s *Server) handleLegacyKnowledgeTransfer(w http.ResponseWriter, r *http.Request) {
	user := s.personFrom(r).ID
	v, err := s.knowledge.MemoryVault(r.Context(), user)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input knowledge.LegacyTransfer
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	job, err := s.knowledge.TransferLegacy(r.Context(), user, v, r.PathValue("id"), input)
	writeResultWithStatus(w, http.StatusAccepted, job, err)
}

func (s *Server) handleResetPendingKnowledgeLocation(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input knowledge.LocationReset
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	saved, err := s.knowledge.ResetPendingLocation(r.Context(), v, input)
	writeResultWithStatus(w, http.StatusAccepted, saved, err)
}

func (s *Server) handleKnowledgeEntries(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	entries, err := s.knowledge.Entries(r.Context(), v)
	writeResult(w, entries, err)
}

func (s *Server) handleKnowledgeEntryRead(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	doc, err := s.knowledge.ReadEntry(r.Context(), v, r.PathValue("entry"), true)
	writeResult(w, doc, err)
}

func (s *Server) handleKnowledgeEntryWrite(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledge.AuthorizedVault(r.Context(), s.personFrom(r).ID, r.PathValue("vault"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input knowledge.WriteRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	job, err := s.knowledge.Write(r.Context(), v, input)
	writeResultWithStatus(w, http.StatusAccepted, job, err)
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
	review, err := s.knowledge.InspectSource(r.Context(), v, r.PathValue("entry"))
	writeResult(w, review, err)
}

func (s *Server) handleRepairKnowledgeIndex(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledge.AuthorizedVault(r.Context(), s.personFrom(r).ID, r.PathValue("vault"))
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
	entries, err := s.knowledge.RepairIndex(r.Context(), v, input.Epoch, input.Confirmed)
	writeResult(w, entries, err)
}

func (s *Server) handleKnowledgeMigrations(w http.ResponseWriter, r *http.Request) {
	moves, err := s.store.ListKnowledgeMigrations(r.Context(), s.personFrom(r).ID)
	writeResult(w, moves, err)
}

func (s *Server) handleBeginKnowledgeMigration(w http.ResponseWriter, r *http.Request) {
	var input knowledge.MigrationRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	move, err := s.knowledge.BeginMigration(r.Context(), s.personFrom(r).ID, r.PathValue("vault"), input)
	writeResultWithStatus(w, http.StatusAccepted, move, err)
}

func (s *Server) handleCancelKnowledgeMigration(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision int64 `json:"revision"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	move, err := s.store.RequestKnowledgeMigrationCancel(r.Context(), s.personFrom(r).ID, r.PathValue("migration"), input.Revision)
	writeResult(w, move, err)
}

func (s *Server) handleKnowledgePublications(w http.ResponseWriter, r *http.Request) {
	items, err := s.knowledge.Publications(r.Context(), s.personFrom(r).ID)
	writeResult(w, items, err)
}

func (s *Server) handlePublishKnowledge(w http.ResponseWriter, r *http.Request) {
	var input knowledge.PublishRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	publication, err := s.knowledge.Publish(r.Context(), s.personFrom(r).ID, input)
	writeResult(w, publication, err)
}

func (s *Server) handleRevokeKnowledgePublication(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision int64 `json:"revision"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	p, err := s.store.RevokeKnowledgePublication(r.Context(), s.personFrom(r).ID, r.PathValue("publication"), input.Revision)
	writeResult(w, p, err)
}

func (s *Server) handleAssistantMemoryAccess(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input knowledge.MemoryRecall
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	grant, err := s.knowledge.GrantMemoryRecall(r.Context(), agent, r.PathValue("vault"), input)
	writeResult(w, grant, err)
}

func (s *Server) handleKnowledgeReplicaCleanup(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListKnowledgeReplicaForgets(r.Context(), s.personFrom(r).ID)
	writeResult(w, items, err)
}

// readKnowledgeForMCP is read_knowledge: what the calling session may read
// of its person's knowledge; listSources only for the person's assistant.
func (s *Server) readKnowledgeForMCP(call mcpCall) (string, error) {
	if !call.actor.Agent() {
		return "", invalid("knowledge recall requires a session identity")
	}
	ctx := call.r.Context()
	session, err := s.store.GetAgentSessionSummary(ctx, call.actor.Identity.SessionID)
	if err != nil {
		return "", err
	}
	var answer map[string]any
	if mcpArgBool(call.args, "listSources") {
		scope, e := s.paScope(ctx, call.actor)
		if e != nil {
			return "", invalid("only the person's assistant discovers owner sources")
		}
		answer, err = s.knowledge.Sources(ctx, scope.Agent)
	} else {
		answer, err = s.knowledge.Recall(ctx, session, knowledge.RecallRequest{
			PublicationID: mcpArgString(call.args, "publicationId"), EntryID: mcpArgString(call.args, "entryId"),
			Query: mcpArgString(call.args, "query"), AfterEntryID: mcpArgString(call.args, "afterEntryId"),
		})
	}
	if err != nil {
		return "", err
	}
	return encodeJSON(answer)
}
