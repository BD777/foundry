package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// Connector writes outside what a session was granted wait for the person
// (DEV-265). Each one is a proposal (pa_proposals) and a Needs you item
// found in it on read, as DEV-254 does for unprocessed messages: the page
// says what would be written where, and allow/decline answers the proposal.
// Allowing makes Foundry replay the recorded request itself.

// connectorWritePendingKey names one proposal's item.
func connectorWritePendingKey(proposalID string) string {
	return "connector_write:" + proposalID
}

func connectorWriteOpenKeys(items []store.PendingItem) map[string]bool {
	keys := map[string]bool{}
	for _, item := range items {
		if item.Source == store.PendingSourceConnectorWrite && item.State == store.PendingOpen {
			keys[item.Key] = true
		}
	}
	return keys
}

// openConnectorWritePendingKeys reads the open connector-write items: what
// the assistant's overview reconciles against without listing the page.
func (s *Server) openConnectorWritePendingKeys(ctx context.Context, userID string) map[string]bool {
	items, err := s.store.ListPendingItems(ctx, userID, []string{store.PendingOpen}, "", 500)
	if err != nil {
		return map[string]bool{}
	}
	return connectorWriteOpenKeys(items)
}

// reconcileConnectorWritePending brings the person's connector-write items
// up to their pending proposals, and closes the items whose proposal was
// decided or expired. openKeys is the set of open item keys the caller
// listed; it must not be nil. It reports whether anything changed.
func (s *Server) reconcileConnectorWritePending(ctx context.Context, userID string, openKeys map[string]bool) bool {
	agents, err := s.store.ListAssistants(ctx, userID)
	if err != nil {
		return false
	}
	current := map[string]bool{}
	changed := false
	for _, agent := range agents {
		if agent.UserID != userID {
			continue
		}
		proposals, err := s.store.ListPersonalAgentProposals(ctx, agent.ID, []string{store.PersonalAgentProposalPending})
		if err != nil {
			continue
		}
		for _, proposal := range proposals {
			if proposal.Kind != store.PersonalAgentProposalConnectorWrite || proposal.UserID != userID {
				continue
			}
			key := connectorWritePendingKey(proposal.ID)
			current[key] = true
			item := s.connectorWritePendingItem(ctx, proposal, agent)
			if _, recorded, err := s.recordPendingItem(ctx, item); err == nil {
				changed = changed || recorded
			}
		}
	}
	for key := range openKeys {
		if current[key] {
			continue
		}
		resolved, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{
			Key: key, Sources: []string{store.PendingSourceConnectorWrite},
			State: store.PendingDone, ResolutionReason: store.PendingResolutionAutoResolved,
			ResolutionDetail: "proposal_settled",
		})
		if err == nil {
			changed = changed || resolved > 0
		}
	}
	return changed
}

// connectorWritePendingItem is one pending proposal as a Needs you item:
// the account, the target object, the message's own words, and the origin.
func (s *Server) connectorWritePendingItem(ctx context.Context, proposal store.PersonalAgentProposal, agent store.PersonalAgent) store.PendingItem {
	var spec connectors.ConnectorConfirmationSpec
	_ = json.Unmarshal(proposal.Spec, &spec)
	name := strings.TrimSpace(spec.AccountName)
	if name == "" {
		name = strings.TrimSpace(spec.Connector)
	}
	operation := strings.TrimSpace(spec.Operation)
	if operation == "" {
		operation = strings.TrimSpace(spec.Method + " " + spec.Path)
	}
	preview, bodyText := connectors.PreviewBody(spec.Body)
	action := "write"
	switch {
	case strings.Contains(spec.Path, "/reactions"):
		action = "reaction"
	case strings.TrimSpace(spec.Text) != "":
		action = "message"
	}
	detail := &store.PendingConnectorWriteDetail{
		ProposalID:  proposal.ID,
		Action:      action,
		Operation:   operation,
		ExpiresAt:   proposal.ExpiresAt,
		AccountName: name,
		Text:        textcut.Excerpt(spec.Text, pendingExcerptLimit),
		Preview:     preview,
		Body:        bodyText,
	}
	if len(spec.Objects) > 0 {
		detail.TargetType, detail.TargetID = spec.Objects[0].Type, spec.Objects[0].ID
		for _, label := range spec.Labels {
			if label.Type == detail.TargetType && label.ID == detail.TargetID {
				detail.TargetName = strings.TrimSpace(label.Name)
				break
			}
		}
	}
	workspaceID := proposal.WorkspaceID
	if session, err := s.store.GetAgentSessionSummary(ctx, proposal.SessionID); err == nil {
		if session.WorkspaceID != "" {
			workspaceID = session.WorkspaceID
		}
		detail.FromHelper = session.ParentSessionID != ""
		if origin := session.Input.ChannelOrigin; origin != nil {
			detail.ChannelName = origin.ChannelName
			detail.ConversationKind = string(origin.Conversation.Kind)
			detail.ConversationName = origin.Conversation.Name
		}
	}
	key := connectorWritePendingKey(proposal.ID)
	return store.PendingItem{
		UserID: proposal.UserID, AssistantID: agent.ID, WorkspaceID: workspaceID,
		SessionID: proposal.SessionID, Source: store.PendingSourceConnectorWrite,
		Key: key, EventID: key, Title: name,
		Excerpt:        textcut.Excerpt(spec.Text, pendingExcerptLimit),
		ConnectorWrite: detail,
	}
}

// handleDecidePendingItem answers one connector-write item: allow sends the
// recorded request through Foundry, decline sends nothing. The proposal's
// pending->accepted transition is the once-only guard.
func (s *Server) handleDecidePendingItem(w http.ResponseWriter, r *http.Request) {
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "pending items belong to a signed-in account")
		return
	}
	var input struct {
		Allow *bool `json:"allow"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Allow == nil {
		writeError(w, http.StatusBadRequest, "an answer says allow true or false")
		return
	}
	ctx := r.Context()
	item, err := s.store.GetPendingItem(ctx, user, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "pending item not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read pending item")
		return
	}
	if item.Source != store.PendingSourceConnectorWrite || item.ConnectorWrite == nil || item.ConnectorWrite.ProposalID == "" {
		writeError(w, http.StatusConflict, "only a connector write is allowed or refused here")
		return
	}
	if item.State != store.PendingOpen {
		writeError(w, http.StatusConflict, "this write was already answered")
		return
	}
	agent, err := s.store.GetAssistant(ctx, item.AssistantID)
	if err != nil || agent.UserID != user {
		writeError(w, http.StatusNotFound, "the assistant this write belongs to was not found")
		return
	}
	proposal, err := s.assistant.DecideProposal(ctx, agent, item.ConnectorWrite.ProposalID, *input.Allow, store.PersonalAgentViaWeb)
	if err != nil {
		writeResult(w, proposal, err)
		return
	}
	if _, err := s.store.ResolvePendingItem(ctx, user, item.ID, store.PendingDone, store.PendingOutcomePersonAnswered, store.PendingAnswer{}); err != nil {
		writeError(w, http.StatusInternalServerError, "the write was answered, but its item could not be closed")
		return
	}
	writeJSON(w, http.StatusOK, proposal)
}
