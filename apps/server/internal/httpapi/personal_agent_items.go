package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// 「事项」 (DEV-258) on /api/personal-agent/items: the person's list of what
// they want done, its timeline, its helpers, archive and restore, and the
// review of a range. The contract is contracts/models/personal_agent.yaml
// (PersonalAgentItem*); these handlers map the store's rows to it and drop
// what it does not show (task, source and capture ids, user and assistant
// ids). The older /api/personal-agent/list routes answer the same handlers.

const (
	personalAgentItemDefaultLimit = 50
	personalAgentItemMaxLimit     = 200
)

// personalAgentItemFilter reads the items page's query: view, owner, from,
// to, q, limit and offset. Out-of-range values answer 400.
func personalAgentItemFilter(w http.ResponseWriter, r *http.Request) (store.PersonalAgentItemFilter, bool) {
	query := r.URL.Query()
	filter := store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewOpen, Query: strings.TrimSpace(query.Get("q")), Limit: personalAgentItemDefaultLimit}
	if value := strings.TrimSpace(query.Get("view")); value != "" {
		filter.View = value
	}
	switch filter.View {
	case store.PersonalAgentItemViewOpen, store.PersonalAgentItemViewFinished, store.PersonalAgentItemViewArchived:
	default:
		writeError(w, http.StatusBadRequest, "view must be open, finished or archived")
		return filter, false
	}
	switch owner := strings.TrimSpace(query.Get("owner")); owner {
	case "":
	case store.PersonalAgentItemOwnerPerson, store.PersonalAgentItemOwnerAssistant:
		filter.Owner = owner
	default:
		writeError(w, http.StatusBadRequest, "owner must be person or assistant")
		return filter, false
	}
	from, ok := personalAgentItemInstant(w, query, "from")
	if !ok {
		return filter, false
	}
	to, ok := personalAgentItemInstant(w, query, "to")
	if !ok {
		return filter, false
	}
	if from != nil && to != nil && !from.Before(*to) {
		writeError(w, http.StatusBadRequest, "from must be before to")
		return filter, false
	}
	filter.From, filter.To = formatPersonalAgentItemInstant(from), formatPersonalAgentItemInstant(to)
	if value := strings.TrimSpace(query.Get("limit")); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > personalAgentItemMaxLimit {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
			return filter, false
		}
		filter.Limit = limit
	}
	if value := strings.TrimSpace(query.Get("offset")); value != "" {
		offset, err := strconv.Atoi(value)
		if err != nil || offset < 0 {
			writeError(w, http.StatusBadRequest, "offset must be 0 or more")
			return filter, false
		}
		filter.Offset = offset
	}
	return filter, true
}

// personalAgentItemInstant reads an RFC 3339 query instant; nil when the
// parameter is absent.
func personalAgentItemInstant(w http.ResponseWriter, query url.Values, name string) (*time.Time, bool) {
	value := strings.TrimSpace(query.Get(name))
	if value == "" {
		return nil, true
	}
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		writeError(w, http.StatusBadRequest, name+" must be an RFC 3339 time")
		return nil, false
	}
	return &at, true
}

// formatPersonalAgentItemInstant is the store's form of an instant: UTC,
// RFC 3339 with nanoseconds, which SQLite compares as an instant.
func formatPersonalAgentItemInstant(at *time.Time) string {
	if at == nil {
		return ""
	}
	return at.UTC().Format(time.RFC3339Nano)
}

// personalAgentItemError gives a store refusal of an item call its status.
func personalAgentItemError(err error) error {
	switch {
	case errors.Is(err, store.ErrPersonalAgentItemInvalid):
		return &statusError{http.StatusBadRequest, err}
	case errors.Is(err, store.ErrPersonalAgentItemNotArchivable):
		return &statusError{http.StatusConflict, err}
	}
	return err
}

// handleListPersonalAgentItems answers one page of the items page
// (GET /api/personal-agent/items).
func (s *Server) handleListPersonalAgentItems(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	filter, ok := personalAgentItemFilter(w, r)
	if !ok {
		return
	}
	s.writePersonalAgentItemPage(w, r, agent, filter)
}

// handleLegacyListPersonalAgentItems is the older GET /api/personal-agent/list:
// the same page, and ?closedSince= (an RFC 3339 time) asks for the open
// items and those closed since it, as it always did.
func (s *Server) handleLegacyListPersonalAgentItems(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	filter, ok := personalAgentItemFilter(w, r)
	if !ok {
		return
	}
	if value := strings.TrimSpace(r.URL.Query().Get("closedSince")); value != "" {
		since, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "closedSince must be an RFC 3339 time")
			return
		}
		filter.ClosedSince = since.UTC().Format(time.RFC3339Nano)
	}
	s.writePersonalAgentItemPage(w, r, agent, filter)
}

func (s *Server) writePersonalAgentItemPage(w http.ResponseWriter, r *http.Request, agent store.PersonalAgent, filter store.PersonalAgentItemFilter) {
	ctx := r.Context()
	page, err := s.store.ListPersonalAgentItemPage(ctx, agent.ID, filter)
	if err != nil {
		writeResult(w, nil, personalAgentItemError(err))
		return
	}
	items := make([]store.PersonalAgentItem, 0, len(page.Items))
	for _, item := range page.Items {
		view, err := s.personalAgentItemView(ctx, item, page.Helpers[item.ID])
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		items = append(items, view)
	}
	list := store.PersonalAgentItemList{Items: items, Total: page.Total, Offset: page.Offset}
	if page.NextOffset > 0 {
		next := page.NextOffset
		list.NextOffset = &next
	}
	writeResult(w, list, nil)
}

// handleGetPersonalAgentItem answers one item with its helpers and its
// timeline, oldest first (GET /api/personal-agent/items/{id}).
func (s *Server) handleGetPersonalAgentItem(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	item, err := s.store.GetPersonalAgentItem(ctx, agent.ID, r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.personalAgentItemWithHelpers(ctx, agent.ID, item)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	events, err := s.store.ListPersonalAgentItemEvents(ctx, agent.ID, item.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, store.PersonalAgentItemDetail{Item: view, Events: events}, nil)
}

// handleReportPersonalAgentItems answers the review of [from, to)
// (GET /api/personal-agent/items/report). It is data only; the assistant
// may write prose from it. Registered as a literal route, so it is never
// read as an item id.
func (s *Server) handleReportPersonalAgentItems(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	from, ok := personalAgentItemInstant(w, query, "from")
	if !ok {
		return
	}
	to, ok := personalAgentItemInstant(w, query, "to")
	if !ok {
		return
	}
	if from == nil || to == nil {
		writeError(w, http.StatusBadRequest, "from and to are required RFC 3339 times")
		return
	}
	if !from.Before(*to) {
		writeError(w, http.StatusBadRequest, "from must be before to")
		return
	}
	ctx := r.Context()
	report, err := s.store.ReportPersonalAgentItems(ctx, agent.ID, formatPersonalAgentItemInstant(from), formatPersonalAgentItemInstant(to))
	if err != nil {
		writeResult(w, nil, personalAgentItemError(err))
		return
	}
	groups := make([]store.PersonalAgentItemReportGroup, 0, len(report.Groups))
	for _, group := range report.Groups {
		items := make([]store.PersonalAgentItem, 0, len(group.Items))
		for _, item := range group.Items {
			view, err := s.personalAgentItemView(ctx, item, report.Helpers[item.ID])
			if err != nil {
				writeResult(w, nil, err)
				return
			}
			items = append(items, view)
		}
		groups = append(groups, store.PersonalAgentItemReportGroup{Status: group.Status, Items: items})
	}
	writeResult(w, store.PersonalAgentItemReport{From: report.From, To: report.To, Counts: report.Counts, Groups: groups}, nil)
}

// handleEditPersonalAgentItem is the person's own edit
// (PUT /api/personal-agent/items/{id}): the fields the body names and, when it
// names archived, the archive or restore that goes with them. A request the
// store refuses writes nothing: an archive of an open item is 409, a stale
// revision 409, a dependency cycle 400.
func (s *Server) handleEditPersonalAgentItem(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.PersonalAgentItemEditInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	fields := store.PersonalAgentListItemInput{Text: optionalString(input.Text), When: optionalString(input.When), Status: optionalString(input.Status), Owner: optionalString(input.Owner)}
	if input.Revision != 0 {
		revision := int64(input.Revision)
		fields.Revision = &revision
	}
	fields.PlanChoice = input.Plan
	if err := s.editPersonalAgentItem(ctx, agent, id, fields, input.Archived); err != nil {
		writeResult(w, nil, err)
		return
	}
	item, err := s.store.GetPersonalAgentItem(ctx, agent.ID, id)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.personalAgentItemWithHelpers(ctx, agent.ID, item)
	writeResult(w, view, err)
}

func (s *Server) handleDeletePersonalAgentItem(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if err := s.store.DeletePersonalAgentItem(r.Context(), agent.ID, r.PathValue("id")); err != nil {
		writeResult(w, nil, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// optionalString is a generated string field's value: nil when the body
// left it out, which the generated type shows as "".
func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// editPersonalAgentItem is the person's edit of an item (PUT
// /api/personal-agent/items/{id}): the assistant's EditItem, recorded as the
// person. It saves the fields and the archive in one transaction, and the
// item's helper sessions follow its archive.
func (s *Server) editPersonalAgentItem(ctx context.Context, agent store.PersonalAgent, id string, fields store.PersonalAgentListItemInput, archived *bool) error {
	_, err := s.assistant.EditItem(ctx, agent, id, fields, archived, store.PersonalAgentActorPerson)
	return err
}

// archiveItemSessions archives the helper sessions an item takes with it, one
// archive call each, skipping those already archived. Each session the call
// takes gets an archived event on the item, recorded for recordAs; one the call
// refuses gets none. It returns the failures, each named by its session, so
// the sweep and the person's archive can report them.
func (s *Server) archiveItemSessions(ctx context.Context, actor Actor, recordAs, assistantID, itemID string, sessionIDs []string) error {
	var failures []error
	for _, id := range sessionIDs {
		session, err := s.store.GetAgentSessionSummary(ctx, id)
		if err != nil {
			failures = append(failures, fmt.Errorf("session %s: %w", id, err))
			continue
		}
		if session.ArchivedAt != "" {
			continue
		}
		if err := s.setItemSessionArchived(ctx, actor, session, false); err != nil {
			failures = append(failures, fmt.Errorf("session %s: %w", id, err))
			continue
		}
		if err := s.store.RecordPersonalAgentItemSessionEvent(ctx, recordAs, assistantID, itemID, store.PersonalAgentItemEventArchived, id); err != nil {
			failures = append(failures, fmt.Errorf("session %s: %w", id, err))
		}
	}
	return errors.Join(failures...)
}

// restoreItemSessions restores exactly the helper sessions the item's last
// archive took (cascaded: the archived events that named them), and records each restore
// for recordAs. A session is restored only while it still holds the archive
// that its event recorded: one the person archived by hand since then, or one
// never taken by the cascade, stays archived.
func (s *Server) restoreItemSessions(ctx context.Context, actor Actor, recordAs, assistantID, itemID string, cascaded []store.PersonalAgentItemEvent) error {
	var failures []error
	seen := map[string]bool{}
	for index := len(cascaded) - 1; index >= 0; index-- {
		event := cascaded[index]
		id := event.Detail.SessionID
		if seen[id] {
			continue
		}
		seen[id] = true
		session, err := s.store.GetAgentSessionSummary(ctx, id)
		if err != nil {
			failures = append(failures, fmt.Errorf("session %s: %w", id, err))
			continue
		}
		if session.ArchivedAt == "" {
			continue
		}
		archivedAt, err := time.Parse(time.RFC3339Nano, session.ArchivedAt)
		if err != nil {
			failures = append(failures, fmt.Errorf("session %s archive time %q: %w", id, session.ArchivedAt, err))
			continue
		}
		cascadedAt, err := time.Parse(time.RFC3339Nano, event.At)
		if err != nil {
			failures = append(failures, fmt.Errorf("session %s event time %q: %w", id, event.At, err))
			continue
		}
		if archivedAt.After(cascadedAt) {
			continue
		}
		if err := s.setItemSessionArchived(ctx, actor, session, true); err != nil {
			failures = append(failures, fmt.Errorf("session %s: %w", id, err))
			continue
		}
		if err := s.store.RecordPersonalAgentItemSessionEvent(ctx, recordAs, assistantID, itemID, store.PersonalAgentItemEventRestored, id); err != nil {
			failures = append(failures, fmt.Errorf("session %s: %w", id, err))
		}
	}
	return errors.Join(failures...)
}

// setItemSessionArchived archives or restores one helper session through
// archiveChats, the session archive the chat list uses, and checks it took.
func (s *Server) setItemSessionArchived(ctx context.Context, actor Actor, session store.AgentSession, restore bool) error {
	input := store.ArchiveChatsInput{WorkspaceID: session.WorkspaceID, ChatIDs: []string{session.ID}}
	result, err := s.archiveChats(ctx, actor, input, restore)
	if err != nil {
		return err
	}
	if !slices.Contains(result.Archived, session.ID) {
		return errors.New("the session archive did not take it")
	}
	return nil
}

// archiveItemSessionsForAssistant is the assistant's port for an item's archive
// (assistant.Ports.ArchiveItemSessions): the sessions are archived as the person
// whose assistant the item is on, and recorded for recordAs.
func (s *Server) archiveItemSessionsForAssistant(ctx context.Context, recordAs, assistantID, itemID string, sessionIDs []string) error {
	actor, err := s.personActorOf(ctx, assistantID)
	if err != nil {
		return err
	}
	return s.archiveItemSessions(ctx, actor, recordAs, assistantID, itemID, sessionIDs)
}

// restoreItemSessionsForAssistant is the assistant's port for an item's restore
// (assistant.Ports.RestoreItemSessions), as archiveItemSessionsForAssistant.
func (s *Server) restoreItemSessionsForAssistant(ctx context.Context, recordAs, assistantID, itemID string, cascaded []store.PersonalAgentItemEvent) error {
	actor, err := s.personActorOf(ctx, assistantID)
	if err != nil {
		return err
	}
	return s.restoreItemSessions(ctx, actor, recordAs, assistantID, itemID, cascaded)
}

// personActorOf is the person whose assistant assistantID is, the actor the
// session archive of its items runs as.
func (s *Server) personActorOf(ctx context.Context, assistantID string) (Actor, error) {
	agent, err := s.store.GetAssistant(ctx, assistantID)
	if err != nil {
		return Actor{}, err
	}
	person, err := s.store.GetUser(ctx, agent.UserID)
	if err != nil {
		return Actor{}, err
	}
	return Actor{Kind: ActorAccount, Account: &person}, nil
}

// personalAgentItemWithHelpers is one item with the helpers that work on it.
func (s *Server) personalAgentItemWithHelpers(ctx context.Context, assistantID string, item store.PersonalAgentListItem) (store.PersonalAgentItem, error) {
	tasks, err := s.store.ListPersonalAgentTasks(ctx, assistantID, nil)
	if err != nil {
		return store.PersonalAgentItem{}, err
	}
	var helpers []store.PersonalAgentTask
	for _, task := range tasks {
		if task.ItemID == item.ID {
			helpers = append(helpers, task)
		}
	}
	return s.personalAgentItemView(ctx, item, helpers)
}

// personalAgentItemView maps a store item and its helper tasks to the
// contract's PersonalAgentItem.
func (s *Server) personalAgentItemView(ctx context.Context, item store.PersonalAgentListItem, tasks []store.PersonalAgentTask) (store.PersonalAgentItem, error) {
	helpers := make([]store.PersonalAgentItemHelper, 0, len(tasks))
	for _, task := range tasks {
		helper, err := s.personalAgentHelperView(ctx, task)
		if err != nil {
			return store.PersonalAgentItem{}, err
		}
		helpers = append(helpers, helper)
	}
	return store.PersonalAgentItem{
		ID:             item.ID,
		IntentRevision: int(item.IntentRevision),
		Revision:       int(item.Revision),
		Owner:          item.Owner,
		Text:           item.Text,
		When:           item.When,
		At:             item.At,
		Remind:         item.Remind,
		Status:         item.Status,
		Summary:        item.Summary,
		Quote:          item.Quote,
		Origin:         item.Origin,
		Plan:           item.Plan,
		ArchivedAt:     item.ArchivedAt,
		RemindedAt:     item.RemindedAt,
		CreatedAt:      item.CreatedAt,
		UpdatedAt:      item.UpdatedAt,
		ClosedAt:       item.ClosedAt,
		Helpers:        helpers,
	}, nil
}

// personalAgentHelperView is one helper of an item: its session, its
// project while that still exists, and whether its session is archived.
func (s *Server) personalAgentHelperView(ctx context.Context, task store.PersonalAgentTask) (store.PersonalAgentItemHelper, error) {
	helper := store.PersonalAgentItemHelper{
		SessionID:   task.SessionID,
		Title:       task.Title,
		WorkspaceID: task.WorkspaceID,
		Status:      task.Status,
		ReadOnly:    task.ReadOnly,
		StartedAt:   task.CreatedAt,
		EndedAt:     task.EndedAt,
	}
	workspace, err := s.store.GetWorkspace(ctx, task.WorkspaceID)
	switch {
	case err == nil:
		helper.Project = workspace.Name
	case !errors.Is(err, store.ErrNotFound):
		return helper, fmt.Errorf("read helper workspace: %w", err)
	}
	if task.SessionID == "" {
		return helper, nil
	}
	session, err := s.store.GetAgentSessionSummary(ctx, task.SessionID)
	switch {
	case err == nil:
		helper.Archived = session.ArchivedAt != ""
	case !errors.Is(err, store.ErrNotFound):
		return helper, fmt.Errorf("read helper session: %w", err)
	}
	return helper, nil
}
