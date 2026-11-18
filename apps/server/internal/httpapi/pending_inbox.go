package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// Unprocessed assistant messages as pending items (DEV-254): one item per
// saved message the person's assistant has not processed, found in pa_inbox,
// the record that already holds the message and its attempt. Its item
// carries the failure's reason so the Needs you page reads it the way the
// assistant's side card used to, and retry or dismissal closes it.

// inboxWaitingTransient are the waiting reasons that clear on their own: the
// assistant is busy with the message before, or a delivery step is running.
// They are not the person's to do and are never counted.
var inboxWaitingTransient = map[string]bool{
	"assistant_busy":       true,
	"receipt_unavailable":  true,
	"dispatch_unavailable": true,
	"session_unavailable":  true,
}

// inboxEntryTried reports whether the entry records an attempt's outcome.
func inboxEntryTried(entry store.PersonalAgentInboxEntry) bool {
	return entry.ResultStatus == "failed" || entry.ResultStatus == "canceled"
}

// inboxEntryNeedsPerson reports whether the entry is one the person still
// has to deal with: its attempt failed, or it waits on something only the
// person can fix. A resolved entry is done: its answer arrived, or its turn
// was canceled and will not run again (DEV-279).
func inboxEntryNeedsPerson(entry store.PersonalAgentInboxEntry) bool {
	if entry.Status == "cancelled" || entry.Status == "resolved" {
		return false
	}
	if inboxEntryTried(entry) {
		return true
	}
	return entry.Status == "waiting" && entry.SessionID == "" &&
		entry.WaitingReason != "" && !inboxWaitingTransient[entry.WaitingReason]
}

// inboxEntrySettled names how an entry closed, for its item's resolution:
// the person dismissed it, a retry replaced it, its attempt answered it, or
// its turn was canceled (DEV-279).
func inboxEntrySettled(entry store.PersonalAgentInboxEntry) (string, bool) {
	switch {
	case entry.Status == "cancelled" && entry.DismissedBy != "":
		return "dismissed", true
	case entry.Status == "cancelled":
		return "retried", true
	case entry.Status == "resolved" && entry.ResultStatus == "canceled":
		return "canceled", true
	case entry.Status == "resolved":
		return "processed", true
	}
	return "", false
}

func inboxPendingKey(entry store.PersonalAgentInboxEntry) string {
	return "inbox:" + entry.ID
}

// inboxPendingEventID names one attempt or one wait of the message. A closed
// item stays closed for the same event, so a message that fails again after
// its item closed needs a new event to open a new item.
func inboxPendingEventID(entry store.PersonalAgentInboxEntry) string {
	if entry.SessionID != "" {
		return inboxPendingKey(entry) + ":" + entry.SessionID
	}
	return inboxPendingKey(entry) + ":waiting:" + entry.WaitingReason
}

// reconcileInboxPending brings the person's unprocessed-message items up to
// what their assistants' inboxes hold now. openKeys is the set of open item
// keys the caller listed, so settled entries that never had an item cost no
// write; it must not be nil. It reports whether anything changed.
func (s *Server) reconcileInboxPending(ctx context.Context, userID string, openKeys map[string]bool) bool {
	agents, err := s.store.ListAssistants(ctx, userID)
	if err != nil {
		return false
	}
	now := time.Now().UTC()
	changed := false
	for _, agent := range agents {
		if agent.UserID != userID {
			continue
		}
		entries, err := s.store.ListPersonalAgentInbox(ctx, agent.ID, 200)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			key := inboxPendingKey(entry)
			if inboxEntryNeedsPerson(entry) {
				item := s.inboxPendingItem(ctx, entry, agent, now)
				if _, recorded, err := s.store.RecordPendingItem(ctx, item); err == nil {
					changed = changed || recorded
				}
				continue
			}
			if !openKeys[key] {
				continue
			}
			// The message is no longer the person's: an attempt runs or the
			// message was answered. Its item closes, so it never says
			// "waiting" while the assistant works on it.
			state, detail := store.PendingSuperseded, "processing"
			if settledDetail, settled := inboxEntrySettled(entry); settled {
				state, detail = store.PendingDone, settledDetail
			}
			resolved, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{
				Key: key, Sources: []string{store.PendingSourceAssistantInbox}, State: state,
				ResolutionReason: store.PendingResolutionAutoResolved, ResolutionDetail: detail,
			})
			if err == nil {
				changed = changed || resolved > 0
			}
		}
	}
	return changed
}

// inboxOpenKeys is the open item keys of one source in a listed set.
func inboxOpenKeys(items []store.PendingItem) map[string]bool {
	keys := map[string]bool{}
	for _, item := range items {
		if item.Source == store.PendingSourceAssistantInbox && item.State == store.PendingOpen {
			keys[item.Key] = true
		}
	}
	return keys
}

// openInboxPendingKeys reads the open unprocessed-message items: what the
// assistant's overview reconciles against without listing the page.
func (s *Server) openInboxPendingKeys(ctx context.Context, userID string) map[string]bool {
	items, err := s.store.ListPendingItems(ctx, userID, []string{store.PendingOpen}, "", 500)
	if err != nil {
		return map[string]bool{}
	}
	return inboxOpenKeys(items)
}

// inboxPendingItem is one unprocessed message as a pending item: its own
// words, the reason it waits (its attempt's classified failure or the
// waiting reason), and the attempt's error as context.
func (s *Server) inboxPendingItem(
	ctx context.Context,
	entry store.PersonalAgentInboxEntry,
	agent store.PersonalAgent,
	now time.Time,
) store.PendingItem {
	workspaceID := agent.WorkspaceID
	if entry.SessionID != "" {
		if session, err := s.store.GetAgentSessionSummary(ctx, entry.SessionID); err == nil && session.WorkspaceID != "" {
			workspaceID = session.WorkspaceID
		}
	}
	key := inboxPendingKey(entry)
	item := store.PendingItem{
		UserID: entry.UserID, AssistantID: agent.ID, WorkspaceID: workspaceID, SessionID: entry.SessionID,
		Source: store.PendingSourceAssistantInbox, Key: key, EventID: inboxPendingEventID(entry),
		Title: pendingTitle(entry.Text), Excerpt: textcut.Excerpt(entry.Text, pendingExcerptLimit),
	}
	if entry.ResultStatus == "canceled" {
		item.Rule = "canceled"
		item.Context = textcut.Excerpt(entry.ResultError, pendingContextLimit)
		return item
	}
	if entry.ResultStatus == "failed" {
		at := parseStoredPendingTime(entry.UpdatedAt)
		if at.IsZero() {
			at = now
		}
		failure := classifyTurnFailure("", entry.ResultError, at)
		item.FailureCategory = failure.category
		if !failure.resetAt.IsZero() {
			item.FailureResetAt = formatPendingTime(failure.resetAt)
		}
		item.Context = textcut.Excerpt(entry.ResultError, pendingContextLimit)
		return item
	}
	item.Rule = entry.WaitingReason
	return item
}

// assistantInboxTurn reports whether a session's current turn ran for a
// saved assistant message: its failure belongs to that message's own item,
// never to a second turn_failed item (DEV-254).
func (s *Server) assistantInboxTurn(ctx context.Context, session store.AgentSession) bool {
	if session.Input.ID == "" || session.CreatedByUserID == "" {
		return false
	}
	agent, err := s.store.AssistantForSession(ctx, session.ID)
	if err != nil || agent.UserID != session.CreatedByUserID {
		return false
	}
	_, err = s.store.PersonalAgentInboxByInput(ctx, agent.ID, session.Input.ID)
	return err == nil
}

// inboxItemEntry loads the assistant and inbox entry a pending item was
// found in, for the person who owns it.
func (s *Server) inboxItemEntry(
	ctx context.Context,
	userID string,
	item store.PendingItem,
) (store.PersonalAgent, store.PersonalAgentInboxEntry, error) {
	if item.AssistantID == "" {
		return store.PersonalAgent{}, store.PersonalAgentInboxEntry{}, store.ErrNotFound
	}
	agent, err := s.store.GetAssistant(ctx, item.AssistantID)
	if err != nil || agent.UserID != userID {
		return store.PersonalAgent{}, store.PersonalAgentInboxEntry{}, store.ErrNotFound
	}
	entryID := strings.TrimPrefix(item.Key, "inbox:")
	if entryID == "" || entryID == item.Key {
		return store.PersonalAgent{}, store.PersonalAgentInboxEntry{}, store.ErrNotFound
	}
	entry, err := s.store.GetPersonalAgentInbox(ctx, agent.ID, entryID)
	return agent, entry, err
}

// handleRetryPendingItem asks for one more attempt of the message an
// unprocessed-message item stands for. Only that source can be retried here:
// other items are settled by answering them or where they were found.
func (s *Server) handleRetryPendingItem(w http.ResponseWriter, r *http.Request) {
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "pending items belong to a signed-in account")
		return
	}
	var input struct {
		RequestID string `json:"requestId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" || len(requestID) > 100 {
		writeError(w, http.StatusBadRequest, "a retry needs a requestId")
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
	if item.Source != store.PendingSourceAssistantInbox {
		writeError(w, http.StatusConflict, "only an unprocessed assistant message can be retried here")
		return
	}
	if item.State != store.PendingOpen {
		writeError(w, http.StatusConflict, "this message is no longer waiting")
		return
	}
	agent, entry, err := s.inboxItemEntry(ctx, user, item)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "the saved message was not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read the saved message")
		return
	}
	if _, err := s.assistant.RetryInbox(ctx, agent, entry.ID, store.PersonalAgentInboxAction{
		Action: "retry", Revision: entry.Revision, RequestID: requestID,
	}); err != nil {
		code, status := inboxRetryRefusal(err)
		if code == inboxRetryFailedCode {
			log.Printf("pending retry %s: %v", item.ID, err)
		}
		writeJSON(w, status, map[string]string{"code": code, "error": inboxRetryErrors[code]})
		return
	}
	// The retry cancelled the old attempt; its item is settled by the
	// person's action. The new attempt gets its own item if it fails.
	resolved, err := s.store.ResolvePendingItem(ctx, user, item.ID, store.PendingDone, store.PendingOutcomePersonAnswered, store.PendingAnswer{})
	if err != nil {
		log.Printf("pending retry %s: resolve item: %v", item.ID, err)
	}
	writeJSON(w, http.StatusOK, resolved)
}

// dismissInboxItem closes an unprocessed-message item and the message it
// stands for together: "not for me" means it is not processed, not retried.
func (s *Server) dismissInboxItem(ctx context.Context, userID string, item store.PendingItem) error {
	agent, entry, err := s.inboxItemEntry(ctx, userID, item)
	if errors.Is(err, store.ErrNotFound) {
		return nil // the message is gone; only the item is left to close
	}
	if err != nil {
		return err
	}
	if _, err := s.assistant.DismissInbox(ctx, agent, entry.ID, store.PersonalAgentInboxAction{
		Action: "dismiss", Revision: entry.Revision,
	}); err != nil {
		var refusal *personalagent.Refusal
		if errors.As(err, &refusal) && entry.Status == "cancelled" {
			return nil // already dismissed by an earlier request
		}
		return err
	}
	return nil
}

// Codes a refused retry carries. The Needs you page words each one in its own
// language; the English in inboxRetryErrors is for logs and other clients,
// never for the person (DEV-254).
const (
	inboxRetryNotSettledCode = "inbox_retry_not_settled"
	inboxRetryChangedCode    = "inbox_retry_changed"
	inboxRetryFailedCode     = "inbox_retry_failed"
)

var inboxRetryErrors = map[string]string{
	inboxRetryNotSettledCode: "the last attempt is not confirmed finished yet",
	inboxRetryChangedCode:    "the message changed or cannot be retried now",
	inboxRetryFailedCode:     "the message could not be retried",
}

// inboxRetryRefusal names why a retry was refused and the status it answers
// with (DEV-254). Anything not recognised is a failure, not a refusal.
func inboxRetryRefusal(err error) (string, int) {
	switch {
	case errors.Is(err, store.ErrInboxRetryNotSettled):
		return inboxRetryNotSettledCode, http.StatusConflict
	case errors.Is(err, store.ErrInboxNotRetryable), errors.Is(err, store.ErrPersonalAgentRevision):
		return inboxRetryChangedCode, http.StatusConflict
	}
	return inboxRetryFailedCode, http.StatusInternalServerError
}

// inboxMessageAt is when the unprocessed message was sent: its inbox entry's
// own time. An item recorded later does not carry it. Empty when the message
// is gone (DEV-254).
func (s *Server) inboxMessageAt(ctx context.Context, userID string, item store.PendingItem) string {
	_, entry, err := s.inboxItemEntry(ctx, userID, item)
	if err != nil {
		return ""
	}
	return entry.CreatedAt
}
