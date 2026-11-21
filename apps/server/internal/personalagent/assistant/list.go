package assistant

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// 「事项」 (docs/personal-agent.md §6, store.PersonalAgentListItem): what the
// person told the assistant they plan to do, are doing or did. The assistant
// writes it with update_list, only from the person's own words in the
// conversation (the quote, as remember checks it) where a field is about the
// person, and reads it with read_list. The assistant keeps each item's summary,
// owner and archive; Foundry records the times and events and applies the time
// rule (a closed item is archived after a week). An open item with a time and
// remind set is a reminder: when it is due the server tells the assistant's
// latest conversation, which tells the person wherever they last talked to it.
// The daily digest, when the person turned it on, goes the same way at their
// time with the open items and the work in progress.

// listSpec is update_list's arguments.
type listSpec struct {
	Op   string       `json:"op"`
	Item listItemArgs `json:"item"`
}

// listItemArgs is update_list's item: absent fields stay as they are.
type listItemArgs struct {
	Revision  *int64                       `json:"revision,omitempty"`
	IntentKey string                       `json:"intentKey,omitempty"`
	Plan      *store.PersonalAgentItemPlan `json:"plan,omitempty"`
	ID        string                       `json:"id,omitempty"`
	Text      *string                      `json:"text,omitempty"`
	When      *string                      `json:"when,omitempty"`
	At        *string                      `json:"at,omitempty"`
	Remind    *bool                        `json:"remind,omitempty"`
	Status    *string                      `json:"status,omitempty"`
	Owner     *string                      `json:"owner,omitempty"`
	Summary   *string                      `json:"summary,omitempty"`
	TaskID    *string                      `json:"taskId,omitempty"`
	Quote     string                       `json:"quote,omitempty"`
	// Home is the workspace responsible for the item; "" hands it to the
	// assistant's inbox.
	Home *string `json:"home,omitempty"`
}

const listNoteUngrounded = "not added: the quote is not in anything the person wrote in this conversation (a document, web page, file, helper's output or Foundry's own notice is not their words). The list holds only what the person told you; quote their exact words."

// planUpdateList adds or changes one item of the person's list, archives or
// restores it, or claims or releases it for the calling session. What it says
// of the person (text, when, time, reminder, status) must rest on their words
// in this conversation; the owner, the summary, the home, the linked task, the
// archive and the claim are bookkeeping and need no quote. A workspace
// session (scope.Workspace) adds items with their home there and changes only
// items whose home is there. Its audit keeps the op and the item id only.
func (s *Service) planUpdateList(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var spec listSpec
	if err := DecodeArgs(args, &spec); err != nil {
		return Write{ArgsSummary: "update_list"}, err
	}
	id := strings.TrimSpace(spec.Item.ID)
	write := Write{ArgsSummary: strings.TrimSpace(spec.Op + " " + id),
		Spec: map[string]any{"op": spec.Op, "item": map[string]string{"id": id}}}
	// agent is the assistant whose list holds the item.
	agent := scope.Agent
	recordAs := itemActorOf(scope)
	var item store.PersonalAgentListItem
	switch spec.Op {
	case "add":
		if id != "" {
			return write, invalid("add makes a new item and takes no item.id; to change one, use update")
		}
		if spec.Item.Text == nil {
			return write, invalid("item.text is required to add")
		}
		item = store.PersonalAgentListItem{UserID: agent.UserID, AssistantID: agent.ID, SourceSessionID: scope.SessionID, SourceInputID: scope.Turn.ID,
			Status: store.PersonalAgentItemOpen, Owner: store.PersonalAgentItemOwnerPerson, Origin: itemOriginOf(scope), HomeWorkspaceID: scope.Workspace}
		if source, err := s.store.PersonalAgentInboxByInput(ctx, agent.ID, scope.Turn.ID); err == nil && scope.Workspace == "" {
			item.SourceInboxID = source.RootID
		}
	case "update", "archive", "restore", "claim", "release":
		if spec.Op != "update" && listItemChangesFields(spec.Item) {
			return write, invalid("%s takes only item.id and revision; change the fields with update", spec.Op)
		}
		existing, owner, err := s.scopeItem(ctx, scope, id)
		if err != nil {
			return write, err
		}
		item, agent = existing, owner
		if spec.Item.Revision != nil && *spec.Item.Revision != item.Revision {
			return write, &personalagent.Refusal{Status: http.StatusConflict, Err: store.ErrPersonalAgentRevision}
		}
	default:
		return write, invalid("op must be add, update, archive, restore, claim or release")
	}
	if spec.Op == "claim" || spec.Op == "release" {
		return s.planItemClaim(scope, spec.Op, item, recordAs, write)
	}
	homeChanged, err := s.resolveItemHome(scope, spec, &item)
	if err != nil {
		return write, err
	}
	write.WorkspaceID = item.HomeWorkspaceID
	location := s.PersonLocation(ctx, scope.Agent)
	personal := false
	if spec.Item.Plan != nil {
		if err := s.validateItemPlan(ctx, agent, item.ID, spec.Item.Plan, item.HomeWorkspaceID); err != nil {
			return write, err
		}
		var previous []store.PersonalAgentWorkReference
		if item.Plan != nil {
			previous = item.Plan.WorkRefs
		}
		plan, err := s.withHelperRefs(ctx, agent.ID, item.ID, *spec.Item.Plan, previous)
		if err != nil {
			return write, err
		}
		plan.WorkspaceID = item.HomeWorkspaceID
		item.Plan, personal = &plan, true
	}
	if spec.Item.Text != nil {
		text, err := personalagent.ListItemText(*spec.Item.Text)
		if err != nil {
			return write, invalid("%v", err)
		}
		item.Text, personal = text, true
	}
	if spec.Item.When != nil {
		when, err := personalagent.ListItemWhen(*spec.Item.When)
		if err != nil {
			return write, invalid("%v", err)
		}
		item.When, personal = when, true
	}
	atChanged := false
	if spec.Item.At != nil {
		at, err := personalagent.ListItemAt(*spec.Item.At, location)
		if err != nil {
			return write, invalid("%v", err)
		}
		atChanged, item.At, personal = at != item.At, at, true
	}
	remindSet := false
	if spec.Item.Remind != nil {
		remindSet, item.Remind, personal = *spec.Item.Remind && !item.Remind, *spec.Item.Remind, true
	}
	if spec.Item.Status != nil {
		if err := personalagent.ListItemStatus(*spec.Item.Status); err != nil {
			return write, invalid("%v", err)
		}
		item.Status, personal = *spec.Item.Status, true
	}
	if spec.Item.Owner != nil {
		owner, err := listOwner(*spec.Item.Owner)
		if err != nil {
			return write, err
		}
		item.Owner = owner
	}
	if spec.Item.Summary != nil {
		if utf8.RuneCountInString(*spec.Item.Summary) > store.PersonalAgentItemSummaryMaxLength {
			return write, invalid("item.summary is longer than %d characters: keep the running context short", store.PersonalAgentItemSummaryMaxLength)
		}
		item.Summary = *spec.Item.Summary
	}
	taskID := ""
	if spec.Item.TaskID != nil {
		if scope.Workspace != "" {
			return write, invalid("item.taskId ties one of the assistant's tasks to an item; only the person's assistant sets it")
		}
		taskID = strings.TrimSpace(*spec.Item.TaskID)
		if taskID == "" {
			return write, invalid("item.taskId names one of your tasks; it is not empty")
		}
		_, found, err := s.findTask(ctx, agent.ID, taskID)
		if err != nil {
			return write, err
		}
		if !found {
			return write, invalid("no task %q of yours: item.taskId is the id list_tasks or the turn's context shows", taskID)
		}
	}
	if spec.Op == "update" && !personal && taskID == "" && spec.Item.Owner == nil && spec.Item.Summary == nil && !homeChanged && spec.Item.Home == nil {
		return write, invalid("nothing to change: give the fields to set")
	}
	if item.Remind && item.At == "" {
		return write, invalid("remind needs item.at, the time to remind the person; if you do not know it, ask them once")
	}
	if at, err := time.Parse(time.RFC3339, item.At); err == nil && item.Remind && item.Status == store.PersonalAgentItemOpen &&
		(atChanged || remindSet) && !at.After(time.Now()) {
		return write, invalid("item.at is already past (now %s): a reminder needs a time to come", time.Now().In(location).Format("2006-01-02 15:04 MST"))
	}

	if personal {
		quote := strings.TrimSpace(spec.Item.Quote)
		if quote == "" {
			return write, invalid("item.quote is required: copy the person's own words this rests on from their messages in this conversation")
		}
		said, err := s.personSaid(ctx, scope.SessionID, scope.Turn)
		if err != nil {
			return write, err
		}
		if !personalagent.QuoteGrounded(quote, said) {
			return write, invalid("%s", listNoteUngrounded)
		}
		if item.Quote == "" {
			item.Quote = quote
		}
	}
	if (spec.Op == "add" || spec.Op == "update") && item.Status == store.PersonalAgentItemDone && (item.Plan == nil || len(item.Plan.Evidence) == 0) {
		// Recording something the person says they already did is different from
		// claiming our execution succeeded. Preserve their current words as the
		// self-report; an agent-generated completion needs result evidence.
		words, current := personalagent.PersonWords(scope.Turn)
		if spec.Op != "add" || !current || !personalagent.QuoteGrounded(spec.Item.Quote, []string{words}) {
			return write, invalid("record completion evidence before marking an existing item done; a session ending alone does not prove its goal")
		}
		if item.Plan == nil {
			item.Plan = &store.PersonalAgentItemPlan{Mode: "record", Progress: "review"}
		}
		item.Plan.Evidence = []store.PersonalAgentCompletionEvidence{{Kind: "user", Ref: "session:" + scope.SessionID + "/event/evt_" + scope.Turn.ID, Summary: spec.Item.Quote, ObservedAt: scope.Turn.At}}
	}
	write.Apply = func(ctx context.Context) (any, error) {
		if spec.Op == "archive" || spec.Op == "restore" {
			archived := spec.Op == "archive"
			if (item.ArchivedAt != "") == archived {
				return map[string]any{"status": "unchanged", "item": item, "note": listStateNote(archived)}, nil
			}
			saved, err := s.saveItem(ctx, agent, item, false, &archived, recordAs)
			if err != nil {
				return nil, err
			}
			return map[string]any{"status": "applied", "item": saved}, nil
		}
		var saved store.PersonalAgentListItem
		var err error
		if spec.Op == "add" {
			intentKey := strings.TrimSpace(spec.Item.IntentKey)
			if len(intentKey) > 100 {
				return nil, invalid("intentKey must be at most 100 bytes")
			}
			if intentKey == "" {
				intentKey = flow.Key("intent", item.Text)
			}
			sourceID := scope.Turn.ID
			if item.SourceInboxID != "" {
				sourceID = item.SourceInboxID
			}
			item.CaptureKey = flow.Key("item", agent.UserID, sourceID, intentKey)
			item.CaptureHash, err = flow.Fingerprint(struct {
				Text, When, At, Status, Quote string
				Remind                        bool
				Plan                          *store.PersonalAgentItemPlan
			}{item.Text, item.When, item.At, item.Status, item.Quote, item.Remind, item.Plan})
			if err != nil {
				return nil, err
			}
			saved, err = s.store.AddPersonalAgentItem(ctx, recordAs, item)
			if err != nil {
				return nil, itemRefusal(err)
			}
		} else {
			saved, err = s.saveItem(ctx, agent, item, true, nil, recordAs)
			if err != nil {
				return nil, err
			}
		}
		if saved.Text == "" {
			return map[string]string{"status": "already_removed", "id": saved.ID, "note": "The person removed this item. Replaying its original input does not add it again."}, nil
		}
		if taskID != "" {
			task, found, err := s.findTask(ctx, agent.ID, taskID)
			if err != nil {
				return nil, err
			}
			if !found {
				return nil, invalid("task %q is no longer one of your tasks", taskID)
			}
			if err := s.setTaskItem(ctx, task, saved.ID); err != nil {
				return nil, err
			}
			// The tie saved the item again: answer with its current revision.
			if saved, err = s.store.GetPersonalAgentItem(ctx, agent.ID, saved.ID); err != nil {
				return nil, err
			}
		}
		answer := map[string]any{"status": "applied", "item": saved}
		if note := reminderNote(saved, location); note != "" {
			answer["note"] = note
		}
		return answer, nil
	}
	return write, nil
}

// listItemChangesFields reports whether an update_list item names a field that
// archive and restore do not take.
func listItemChangesFields(item listItemArgs) bool {
	return item.Plan != nil || item.Text != nil || item.When != nil || item.At != nil || item.Remind != nil ||
		item.Status != nil || item.Owner != nil || item.Summary != nil || item.TaskID != nil || item.Home != nil
}

// itemActorOf is who an item's timeline says made a change through scope:
// the assistant, or a session in a workspace.
func itemActorOf(scope Scope) string {
	if scope.Workspace != "" {
		return store.PersonalAgentActorSession
	}
	return store.PersonalAgentActorAssistant
}

// scopeItem finds an item scope may change, and the assistant whose list
// holds it: one on the assistant's own list, or for a workspace session one
// on the person's ledger whose home is that workspace.
func (s *Service) scopeItem(ctx context.Context, scope Scope, id string) (store.PersonalAgentListItem, store.PersonalAgent, error) {
	notFound := refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "no item %q on the person's list (read_list shows them)", id)
	if scope.Workspace == "" {
		item, err := s.store.GetPersonalAgentItem(ctx, scope.Agent.ID, id)
		if errors.Is(err, store.ErrNotFound) {
			return item, scope.Agent, notFound
		}
		return item, scope.Agent, err
	}
	item, err := s.store.GetPersonalAgentItemOfUser(ctx, scope.Agent.UserID, id)
	if errors.Is(err, store.ErrNotFound) {
		return item, scope.Agent, notFound
	}
	if err != nil {
		return item, scope.Agent, err
	}
	if item.HomeWorkspaceID != scope.Workspace {
		return item, scope.Agent, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusForbidden,
			"not allowed: item %q has its home in %s, not in this session's workspace %s; only a session there or the person's assistant changes it",
			id, cmp.Or(item.HomeWorkspaceID, "the assistant's inbox"), scope.Workspace)
	}
	if item.AssistantID == scope.Agent.ID {
		return item, scope.Agent, nil
	}
	agent, err := s.store.GetAssistant(ctx, item.AssistantID)
	return item, agent, err
}

// resolveItemHome applies update_list's home to item: item.home, or the
// older plan.workspaceId, which names the same thing. A new home must be a
// workspace scope reaches (for the assistant, its permission package allows
// it), or "" for the assistant's inbox. A workspace session's new item has
// its home there. It reports whether the home changed.
func (s *Service) resolveItemHome(scope Scope, spec listSpec, item *store.PersonalAgentListItem) (bool, error) {
	home, given := item.HomeWorkspaceID, false
	if spec.Item.Plan != nil && spec.Item.Plan.WorkspaceID != "" {
		home, given = spec.Item.Plan.WorkspaceID, true
	}
	if spec.Item.Home != nil {
		named := strings.TrimSpace(*spec.Item.Home)
		if given && named != home {
			return false, invalid("item.home and plan.workspaceId name different workspaces; give item.home only")
		}
		home = named
	}
	if home == item.HomeWorkspaceID {
		return false, nil
	}
	if spec.Op == "add" && scope.Workspace != "" {
		return false, invalid("a new item from this session has its home in this session's workspace %s; leave item.home out, and move it later with update", scope.Workspace)
	}
	if home != "" && !scope.Reaches(home) {
		if scope.Workspace != "" {
			return false, refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "no workspace %s the person can reach: item.home is one of their workspaces, or empty for the assistant's inbox", home)
		}
		return false, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusForbidden,
			"not allowed: this assistant's permissions do not include project %s; the person adds it in the assistant's settings → Permissions.", home)
	}
	item.HomeWorkspaceID = home
	return true, nil
}

// planItemClaim makes the calling session the item's holder (claim), or lets
// it go (release). A claim replaces the holder before it; only the holder
// releases. Only an open item that is not archived is claimed.
func (s *Service) planItemClaim(scope Scope, op string, item store.PersonalAgentListItem, recordAs string, write Write) (Write, error) {
	write.WorkspaceID = item.HomeWorkspaceID
	if op == "claim" {
		switch {
		case item.ArchivedAt != "":
			return write, refuse(store.PersonalAgentRefusalInvalid, http.StatusConflict, "item %q is archived: restore it (op restore) before claiming it", item.ID)
		case item.Status != store.PersonalAgentItemOpen:
			return write, refuse(store.PersonalAgentRefusalInvalid, http.StatusConflict, "item %q is %s: reopen it (status open) before claiming it", item.ID, item.Status)
		}
	}
	write.Apply = func(ctx context.Context) (any, error) {
		if op == "release" {
			saved, released, err := s.store.ReleasePersonalAgentItem(ctx, recordAs, item.AssistantID, item.ID, scope.SessionID)
			if err != nil {
				return nil, itemRefusal(err)
			}
			if !released {
				return map[string]any{"status": "unchanged", "item": saved, "note": "this session does not hold the item"}, nil
			}
			return map[string]any{"status": "applied", "item": saved}, nil
		}
		saved, replaced, err := s.store.ClaimPersonalAgentItem(ctx, recordAs, item.AssistantID, item.ID, scope.SessionID)
		if err != nil {
			return nil, itemRefusal(err)
		}
		// The signals that waited on the item for a session to follow it
		// go to this one.
		if s.itemClaimed != nil {
			s.itemClaimed(item.AssistantID, item.ID)
		}
		switch {
		case item.HolderSessionID == scope.SessionID:
			return map[string]any{"status": "unchanged", "item": saved, "note": "this session already holds the item"}, nil
		case replaced != "":
			return map[string]any{"status": "applied", "item": saved, "replaced": replaced}, nil
		}
		return map[string]any{"status": "applied", "item": saved}, nil
	}
	return write, nil
}

// listStateNote says an archive or restore that changes nothing.
func listStateNote(archived bool) string {
	if archived {
		return "the item is already archived"
	}
	return "the item is not archived"
}

// listOwner checks an item's owner: the person does it, or the assistant does
// it through its helpers.
func listOwner(owner string) (string, error) {
	switch owner {
	case store.PersonalAgentItemOwnerPerson, store.PersonalAgentItemOwnerAssistant:
		return owner, nil
	}
	return "", invalid("item.owner is person or assistant, not %q", owner)
}

// itemOriginOf is where a new item started: the channel message that
// triggered the turn, or the web. The requester is the sender of the turn's
// last message that is not the assistant's own.
func itemOriginOf(scope Scope) *store.PersonalAgentItemOrigin {
	channel := scope.Turn.ChannelOrigin
	if channel == nil {
		return &store.PersonalAgentItemOrigin{Kind: store.PersonalAgentItemOriginWeb, SessionID: scope.SessionID}
	}
	origin := &store.PersonalAgentItemOrigin{Kind: store.PersonalAgentItemOriginChannel,
		Name: cmp.Or(channel.Conversation.Name, channel.ChannelName), Source: channel.Source, SessionID: scope.SessionID}
	for _, message := range channel.Messages {
		if !message.Sender.IsSelf {
			origin.Requester, origin.RequesterID, origin.MessageID = message.Sender.Name, message.Sender.ID, message.ID
		}
	}
	return origin
}

// reminderNote tells the assistant when Foundry reminds it of the item.
func reminderNote(item store.PersonalAgentListItem, location *time.Location) string {
	at, err := time.Parse(time.RFC3339, item.At)
	if err != nil || !item.Remind || item.Status != store.PersonalAgentItemOpen || item.RemindedAt != "" {
		return ""
	}
	return fmt.Sprintf("Foundry will remind you of it at %s (%s); then remind the person in a sentence.",
		at.In(location).Format("2006-01-02 15:04"), location.String())
}

// findTask finds one of the assistant's tasks by id.
func (s *Service) findTask(ctx context.Context, assistantID, taskID string) (store.PersonalAgentTask, bool, error) {
	tasks, err := s.store.ListPersonalAgentTasks(ctx, assistantID, nil)
	if err != nil {
		return store.PersonalAgentTask{}, false, err
	}
	for _, task := range tasks {
		if task.ID == taskID {
			return task, true, nil
		}
	}
	return store.PersonalAgentTask{}, false, nil
}

// setTaskItem moves a helper to the item it works on. pa_tasks.item_id is the
// one record of which helpers work on an item; the plans of the item it leaves
// and the item it joins show that helper as a session reference.
func (s *Service) setTaskItem(ctx context.Context, task store.PersonalAgentTask, itemID string) error {
	if task.ItemID == itemID {
		return s.refreshItemHelpers(ctx, task.AssistantID, itemID)
	}
	previous := task.ItemID
	task.ItemID = itemID
	if err := s.store.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, task); err != nil {
		return err
	}
	for _, id := range []string{previous, itemID} {
		if err := s.refreshItemHelpers(ctx, task.AssistantID, id); err != nil {
			return err
		}
	}
	return nil
}

// refreshItemHelpers brings an item's session references in line with the
// helpers pa_tasks ties to it. An item with no plan has nowhere to keep them;
// its plan takes them when one is set.
func (s *Service) refreshItemHelpers(ctx context.Context, assistantID, itemID string) error {
	if itemID == "" {
		return nil
	}
	item, err := s.store.GetPersonalAgentItem(ctx, assistantID, itemID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if item.Plan == nil {
		return nil
	}
	plan, err := s.withHelperRefs(ctx, assistantID, itemID, *item.Plan, item.Plan.WorkRefs)
	if err != nil {
		return err
	}
	if slices.Equal(plan.WorkRefs, item.Plan.WorkRefs) {
		return nil
	}
	item.Plan = &plan
	_, err = s.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item)
	return err
}

// withHelperRefs returns plan with its session references replaced by the
// helpers pa_tasks ties to itemID. A helper keeps the relation it had on the
// item (observing when new); the plan's own session references are not kept:
// helpers are linked by their task, never by the plan. Other references stay
// as given. An empty itemID (a new item) has no helpers yet.
func (s *Service) withHelperRefs(ctx context.Context, assistantID, itemID string, plan store.PersonalAgentItemPlan, previous []store.PersonalAgentWorkReference) (store.PersonalAgentItemPlan, error) {
	refs := make([]store.PersonalAgentWorkReference, 0, len(plan.WorkRefs))
	for _, ref := range plan.WorkRefs {
		if ref.Kind != "session" {
			refs = append(refs, ref)
		}
	}
	if itemID != "" {
		tasks, err := s.store.ListPersonalAgentTasks(ctx, assistantID, nil)
		if err != nil {
			return plan, err
		}
		for _, task := range tasks {
			if task.ItemID != itemID || task.SessionID == "" {
				continue
			}
			relation := "observing"
			for _, ref := range previous {
				if ref.Kind == "session" && ref.ID == task.SessionID {
					relation = ref.Relation
				}
			}
			refs = append(refs, store.PersonalAgentWorkReference{Kind: "session", ID: task.SessionID, WorkspaceID: task.WorkspaceID, Relation: relation})
		}
	}
	if len(refs) == 0 {
		refs = nil
	}
	plan.WorkRefs = refs
	return plan, nil
}

// listQuery is read_list's arguments. from and to bound updatedAt as RFC 3339
// instants, [from, to); closedSince is the older form: the open items and those
// closed since a day (its start in the person's zone) or a time.
type listQuery struct {
	Status          string `json:"status"`
	Owner           string `json:"owner"`
	From            string `json:"from"`
	To              string `json:"to"`
	ClosedSince     string `json:"closedSince"`
	IncludeArchived bool   `json:"includeArchived"`
	WorkspaceID     string `json:"workspaceId"`
	Limit           int    `json:"limit"`
	Offset          int    `json:"offset"`
}

const (
	listDefaultLimit = 20
	listMaxLimit     = 50
	// listQuoteLimit is the longest quote read_list shows; a longer one is left out.
	listQuoteLimit = 200
)

// listHelperView is a helper of an item as read_list shows it.
type listHelperView struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title,omitempty"`
	Status    string `json:"status"`
}

// listItemView is an item as read_list shows it: its words, times, status,
// summary, home, the workspaces it touches, its holder and helpers. Events and
// the plan are left out.
type listItemView struct {
	ID         string           `json:"id"`
	Revision   int64            `json:"revision"`
	Text       string           `json:"text"`
	When       string           `json:"when,omitempty"`
	At         string           `json:"at,omitempty"`
	Owner      string           `json:"owner"`
	Status     string           `json:"status"`
	Home       string           `json:"homeWorkspaceId,omitempty"`
	Touches    []string         `json:"touches,omitempty"`
	Holder     string           `json:"holderSessionId,omitempty"`
	Summary    string           `json:"summary,omitempty"`
	Quote      string           `json:"quote,omitempty"`
	CreatedAt  string           `json:"createdAt"`
	UpdatedAt  string           `json:"updatedAt"`
	ClosedAt   string           `json:"closedAt,omitempty"`
	ArchivedAt string           `json:"archivedAt,omitempty"`
	Helpers    []listHelperView `json:"helpers,omitempty"`
}

// listPage is read_list's answer: one page of items, newest updated first,
// with the pending operations.
type listPage struct {
	Now        string                         `json:"now"`
	Total      int                            `json:"total"`
	Offset     int                            `json:"offset"`
	NextOffset int                            `json:"nextOffset,omitempty"`
	Items      []listItemView                 `json:"items"`
	Operations []store.PersonalAgentOperation `json:"operations"`
}

// ReadList is read_list: one page of the person's items that match the query,
// concise, with their helpers. Archived items are left out unless
// includeArchived is set.
func (s *Service) ReadList(ctx context.Context, scope Scope, args map[string]json.RawMessage) (listPage, error) {
	var query listQuery
	if err := DecodeArgs(args, &query); err != nil {
		return listPage{}, err
	}
	limit := query.Limit
	switch {
	case limit == 0:
		limit = listDefaultLimit
	case limit < 0 || limit > listMaxLimit:
		return listPage{}, invalid("limit is 1 to %d", listMaxLimit)
	}
	if query.Offset < 0 {
		return listPage{}, invalid("offset is 0 or more")
	}
	location := s.PersonLocation(ctx, scope.Agent)
	filter := store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewAll, Status: query.Status, Owner: query.Owner,
		From: query.From, To: query.To, IncludeArchived: query.IncludeArchived, Limit: limit, Offset: query.Offset,
		WorkspaceID: strings.TrimSpace(query.WorkspaceID)}
	assistantID := scope.Agent.ID
	if scope.Workspace != "" {
		// A workspace session reads the person's ledger, only what is
		// homed in or touches its workspace.
		if filter.WorkspaceID != "" && filter.WorkspaceID != scope.Workspace {
			return listPage{}, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusForbidden, "not allowed: this session reads only the items of its workspace %s", scope.Workspace)
		}
		assistantID, filter.UserID, filter.WorkspaceID = "", scope.Agent.UserID, scope.Workspace
	}
	if value := strings.TrimSpace(query.ClosedSince); value != "" {
		since, err := closedSinceOf(value, location)
		if err != nil {
			return listPage{}, err
		}
		filter.ClosedSince = formatPATime(since)
	}
	page, err := s.store.ListPersonalAgentItemPage(ctx, assistantID, filter)
	if err != nil {
		return listPage{}, itemRefusal(err)
	}
	operations := []store.PersonalAgentOperation{}
	if scope.Workspace == "" {
		if operations, err = s.store.ListPersonalAgentOperations(ctx, scope.Agent.ID); err != nil {
			return listPage{}, err
		}
	}
	items := make([]listItemView, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, listItemViewOf(item, page.Helpers[item.ID]))
	}
	return listPage{Now: time.Now().In(location).Format("2006-01-02 15:04 MST"), Total: page.Total, Offset: page.Offset,
		NextOffset: page.NextOffset, Items: items, Operations: operations}, nil
}

// closedSinceOf reads closedSince: a day, from its start in the person's zone,
// or an RFC 3339 time.
func closedSinceOf(value string, location *time.Location) (time.Time, error) {
	if day, err := time.ParseInLocation(time.DateOnly, value, location); err == nil {
		return day, nil
	}
	if at, err := time.Parse(time.RFC3339, value); err == nil {
		return at, nil
	}
	return time.Time{}, &personalagent.Refusal{Status: http.StatusBadRequest, Err: errors.New("closedSince is a date (2026-10-13) or a time (RFC 3339)")}
}

// listItemViewOf is an item as read_list shows it, with its helpers.
func listItemViewOf(item store.PersonalAgentListItem, helpers []store.PersonalAgentTask) listItemView {
	view := listItemView{ID: item.ID, Revision: item.Revision, Text: item.Text, When: item.When, At: item.At, Owner: item.Owner, Status: item.Status,
		Home: item.HomeWorkspaceID, Touches: store.ItemTouches(item.HomeWorkspaceID, helpers), Holder: item.HolderSessionID,
		Summary: item.Summary, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt, ClosedAt: item.ClosedAt, ArchivedAt: item.ArchivedAt}
	if utf8.RuneCountInString(item.Quote) <= listQuoteLimit {
		view.Quote = item.Quote
	}
	for _, task := range helpers {
		view.Helpers = append(view.Helpers, listHelperView{SessionID: task.SessionID, Title: task.Title, Status: task.Status})
	}
	return view
}

// EditItem is an edit of one item and its archive, by the person on the web
// (recordAs person) or by the assistant. Changing when clears the time and the
// reminder, which no longer match it. Every check runs before anything is
// written; see saveItem for the archive and its helper sessions.
func (s *Service) EditItem(ctx context.Context, agent store.PersonalAgent, itemID string, input store.PersonalAgentListItemInput, archived *bool, recordAs string) (store.PersonalAgentListItem, error) {
	item, err := s.mergeItemEdit(ctx, agent, itemID, input)
	if err != nil {
		return store.PersonalAgentListItem{}, err
	}
	return s.saveItem(ctx, agent, item, input != (store.PersonalAgentListItemInput{}), archived, recordAs)
}

// saveItem saves an item as an edit or an assistant write merged it: changed
// says whether a field changed, and archived archives or restores the item (nil
// leaves its archive as it is). Reopening an archived item restores it, the
// same as archived=false does. The helper sessions follow the archive: an
// archive archives its ended helper sessions, and a restore restores the ones
// its last archive took. A session the port cannot take is logged and skipped;
// the item is saved all the same.
func (s *Service) saveItem(ctx context.Context, agent store.PersonalAgent, item store.PersonalAgentListItem, changed bool, archived *bool, recordAs string) (store.PersonalAgentListItem, error) {
	previous, err := s.store.GetPersonalAgentItem(ctx, agent.ID, item.ID)
	if err != nil {
		return store.PersonalAgentListItem{}, err
	}
	if archived == nil && item.Status == store.PersonalAgentItemOpen && previous.ArchivedAt != "" {
		reopen := false
		archived = &reopen
	}
	restoring := archived != nil && !*archived && previous.ArchivedAt != ""
	var cascaded []store.PersonalAgentItemEvent
	if restoring {
		events, err := s.store.ListPersonalAgentItemEvents(ctx, agent.ID, item.ID)
		if err != nil {
			return store.PersonalAgentListItem{}, err
		}
		cascaded = cascadedSessionEvents(events)
	}
	var sessions []string
	switch {
	case changed && archived != nil:
		_, sessions, err = s.store.SavePersonalAgentItemArchive(ctx, recordAs, item, *archived)
	case changed:
		_, err = s.store.SavePersonalAgentItem(ctx, recordAs, item)
	case archived != nil:
		sessions, err = s.store.SetPersonalAgentItemArchived(ctx, recordAs, agent.ID, item.ID, *archived)
	}
	if err != nil {
		return store.PersonalAgentListItem{}, itemRefusal(err)
	}
	saved, err := s.store.GetPersonalAgentItem(ctx, agent.ID, item.ID)
	if err != nil {
		return store.PersonalAgentListItem{}, err
	}
	if archived != nil && *archived && len(sessions) > 0 {
		if s.archiveItemSessions == nil {
			log.Printf("personal agent item %s: no port archives its helper sessions", item.ID)
		} else if err := s.archiveItemSessions(ctx, recordAs, agent.ID, item.ID, sessions); err != nil {
			log.Printf("personal agent item %s: archive helper sessions: %v", item.ID, err)
		}
	}
	if restoring && len(cascaded) > 0 {
		if s.restoreItemSessions == nil {
			log.Printf("personal agent item %s: no port restores its helper sessions", item.ID)
		} else if err := s.restoreItemSessions(ctx, recordAs, agent.ID, item.ID, cascaded); err != nil {
			log.Printf("personal agent item %s: restore helper sessions: %v", item.ID, err)
		}
	}
	return saved, nil
}

// cascadedSessionEvents are the archived events that name a helper session
// since the item was last restored: the sessions its last archive took, oldest
// first. A restored event ends a cascade, the item's and each session's.
func cascadedSessionEvents(events []store.PersonalAgentItemEvent) []store.PersonalAgentItemEvent {
	var cascaded []store.PersonalAgentItemEvent
	for _, event := range events {
		switch {
		case event.Kind == store.PersonalAgentItemEventRestored:
			cascaded = nil
		case event.Kind == store.PersonalAgentItemEventArchived && event.Detail != nil && event.Detail.SessionID != "":
			cascaded = append(cascaded, event)
		}
	}
	return cascaded
}

// itemRefusal gives a store refusal of an item write or read its status.
func itemRefusal(err error) error {
	switch {
	case errors.Is(err, store.ErrPersonalAgentRevision), errors.Is(err, store.ErrIdempotencyConflict):
		return &personalagent.Refusal{Status: http.StatusConflict, Err: err}
	case errors.Is(err, store.ErrPersonalAgentItemInvalid):
		return &personalagent.Refusal{Status: http.StatusBadRequest, Err: err}
	case errors.Is(err, store.ErrPersonalAgentItemNotArchivable):
		return &personalagent.Refusal{Status: http.StatusConflict, Err: err}
	}
	return err
}

// HelperItem is the item of the person's list that a helper scope starts
// works on (create_session itemId): one scope may change (scopeItem: the
// assistant's own, or for a workspace session one whose home is there), open
// and not archived.
func (s *Service) HelperItem(ctx context.Context, scope Scope, itemID string) (store.PersonalAgentListItem, error) {
	item, _, err := s.scopeItem(ctx, scope, itemID)
	if err != nil {
		return item, err
	}
	switch {
	case item.ArchivedAt != "":
		return item, refuse(store.PersonalAgentRefusalInvalid, http.StatusConflict, "item %q is archived: restore it with update_list (op restore) before a helper works on it", itemID)
	case item.Status != store.PersonalAgentItemOpen:
		return item, refuse(store.PersonalAgentRefusalInvalid, http.StatusConflict, "item %q is %s: reopen it (update_list status open) before a helper works on it", itemID, item.Status)
	}
	return item, nil
}

// mergeItemEdit checks the person's edit of an item and returns the item as
// it would be saved. It writes nothing.
func (s *Service) mergeItemEdit(ctx context.Context, agent store.PersonalAgent, itemID string, input store.PersonalAgentListItemInput) (store.PersonalAgentListItem, error) {
	item, err := s.store.GetPersonalAgentItem(ctx, agent.ID, itemID)
	if err != nil {
		return store.PersonalAgentListItem{}, err
	}
	bad := func(err error) (store.PersonalAgentListItem, error) {
		return store.PersonalAgentListItem{}, &personalagent.Refusal{Status: http.StatusBadRequest, Err: err}
	}
	if input.Revision != nil && *input.Revision != item.Revision {
		return store.PersonalAgentListItem{}, &personalagent.Refusal{Status: http.StatusConflict, Err: store.ErrPersonalAgentRevision}
	}
	if input.Plan != nil {
		if input.Plan.WorkspaceID != "" && input.Plan.WorkspaceID != item.HomeWorkspaceID {
			if err := s.personReaches(ctx, agent, input.Plan.WorkspaceID); err != nil {
				return store.PersonalAgentListItem{}, err
			}
			item.HomeWorkspaceID = input.Plan.WorkspaceID
		}
		if err := s.validateItemPlan(ctx, agent, item.ID, input.Plan, item.HomeWorkspaceID); err != nil {
			return store.PersonalAgentListItem{}, err
		}
		item.Plan = input.Plan
	}
	if input.Text != nil {
		if item.Text, err = personalagent.ListItemText(*input.Text); err != nil {
			return bad(err)
		}
	}
	if input.When != nil {
		when, err := personalagent.ListItemWhen(*input.When)
		if err != nil {
			return bad(err)
		}
		if when != item.When {
			item.When, item.At, item.Remind = when, "", false
		}
	}
	if input.Status != nil {
		if err := personalagent.ListItemStatus(*input.Status); err != nil {
			return bad(err)
		}
		item.Status = *input.Status
		if item.Status == store.PersonalAgentItemDone {
			if item.Plan == nil {
				item.Plan = &store.PersonalAgentItemPlan{Mode: "record", Progress: "review"}
			}
			item.Plan.Evidence = append(item.Plan.Evidence, store.PersonalAgentCompletionEvidence{Kind: "user", Ref: "person:" + agent.UserID, Summary: "Marked complete by the person", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)})
			if len(item.Plan.Evidence) > 32 {
				item.Plan.Evidence = item.Plan.Evidence[len(item.Plan.Evidence)-32:]
			}
		}
	}
	if input.Owner != nil {
		switch *input.Owner {
		case store.PersonalAgentItemOwnerPerson, store.PersonalAgentItemOwnerAssistant:
			item.Owner = *input.Owner
		default:
			return bad(fmt.Errorf("%w: owner %q is neither person nor assistant", store.ErrPersonalAgentItemInvalid, *input.Owner))
		}
	}
	if input.PlanChoice != nil {
		if err := s.applyPlanChoice(ctx, agent, &item, *input.PlanChoice); err != nil {
			return store.PersonalAgentListItem{}, err
		}
	}
	return item, nil
}

// applyPlanChoice merges the person's choice of how an open item runs over
// its plan: the route, the project (the item's home) and the items it depends
// on; an empty project moves the item back to the inbox. Progress, next
// action, waiting, work refs, evidence and mode stay as the
// assistant set them; an item without a plan starts one in record mode at
// inbox. The store refuses a dependency cycle when the item is saved.
func (s *Service) applyPlanChoice(ctx context.Context, agent store.PersonalAgent, item *store.PersonalAgentListItem, choice store.PersonalAgentItemPlanChoice) error {
	if item.Status != store.PersonalAgentItemOpen {
		return &personalagent.Refusal{Status: http.StatusConflict, Err: errors.New("the plan of an item is chosen only while it is open")}
	}
	plan := store.PersonalAgentItemPlan{Mode: "record", Progress: "inbox"}
	if item.Plan != nil {
		plan = *item.Plan
	}
	if choice.Route != "" {
		if !choice.Route.Valid() {
			return &personalagent.Refusal{Status: http.StatusBadRequest, Err: fmt.Errorf("%w: plan route %q is not one of the routes", store.ErrPersonalAgentItemInvalid, choice.Route)}
		}
		plan.Route = &store.PersonalAgentRouteDecision{Kind: string(choice.Route), NeedsClarification: choice.Route == store.PersonalAgentItemPlanChoiceRouteClarify}
	}
	if home := choice.WorkspaceID; home != nil && *home != item.HomeWorkspaceID {
		if *home != "" {
			if err := s.personReaches(ctx, agent, *home); err != nil {
				return err
			}
		}
		item.HomeWorkspaceID = *home
	}
	plan.WorkspaceID = item.HomeWorkspaceID
	if choice.Dependencies != nil {
		plan.Dependencies = choice.Dependencies
	}
	item.Plan = &plan
	return nil
}

// personReaches refuses a workspace the person cannot read (404).
func (s *Service) personReaches(ctx context.Context, agent store.PersonalAgent, workspaceID string) error {
	roles, err := s.store.WorkspaceRolesForUser(ctx, agent.UserID)
	if err != nil {
		return err
	}
	if roles[workspaceID] == "" {
		return &personalagent.Refusal{Status: http.StatusNotFound, Err: store.ErrNotFound}
	}
	return nil
}

// rehomeItem moves an item of the assistant's list to a new home (create_workspace
// fromItemId), recorded as rehomed for actor.
func (s *Service) rehomeItem(ctx context.Context, agent store.PersonalAgent, itemID, workspaceID, actor string) error {
	item, err := s.store.GetPersonalAgentItem(ctx, agent.ID, itemID)
	if err != nil {
		return err
	}
	if item.HomeWorkspaceID == workspaceID {
		return nil
	}
	item.HomeWorkspaceID = workspaceID
	_, err = s.store.SavePersonalAgentItem(ctx, actor, item)
	return itemRefusal(err)
}

// latestConversation is the assistant conversation the person
// last talked in: where a reminder or the digest reaches them. "" when
// there is none.
func (s *Service) latestConversation(ctx context.Context, agent store.PersonalAgent) string {
	sessions, err := s.store.ListAgentSessionSummaries(ctx, agent.WorkspaceID)
	if err != nil {
		log.Printf("personal agent %s: list conversations: %v", agent.UserID, err)
		return ""
	}
	latest, latestAt := "", ""
	for _, session := range sessions {
		if _, ok := s.Conversation(ctx, session); !ok {
			continue
		}
		if at := cmp.Or(session.ActivityAt, session.LastActivityAt, session.StartedAt); latest == "" || at > latestAt {
			latest, latestAt = session.ID, at
		}
	}
	return latest
}

// listNoticeTexts are the reminder's and the digest's notices, [Chinese,
// English]: the conversation shows them too.
var listNoticeTexts = map[string][2]string{
	"reminder": {"到点提醒（本人清单上的事，%s）：“%s”（本人说的时间：%s；条目 %s）。",
		"Reminder due (an item on the person's list, %s): %q (when they said: %s; item %s)."},
	"digest": {"每日小结时间到了（%s）。Foundry 记下的事实：\n%s",
		"Time for the daily digest (%s). What Foundry has on record:\n%s"},
	"open":       {"清单上还没做的：", "Open on the person's list:"},
	"closed":     {"过去一天做完的：", "Done in the last day:"},
	"dropped":    {"（不做了）", " (dropped)"},
	"tasks":      {"你交出去、还在跟进的事：", "Work you handed off and follow up:"},
	"tasksEnded": {"你交出去、过去一天结束的事：", "Work you handed off that ended in the last day:"},
	"noWhen":     {"没说", "not said"},
	"when":       {"（%s）", " (%s)"},
}

func (s *Service) sayList(ctx context.Context, agent store.PersonalAgent, key string, args ...any) string {
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	text := listNoticeTexts[key][languageIndex(language)]
	if len(args) == 0 {
		return text
	}
	return fmt.Sprintf(text, args...)
}

// reminderInterval is how often due reminders and digests are looked for.
var reminderInterval = time.Minute

// itemArchiveAfter is how long a closed item stays on the list before Foundry archives it.
const itemArchiveAfter = 7 * 24 * time.Hour

// sendDueReminders sends the reminders and daily digests that are
// due now, and archives the items closed long enough ago.
func (s *Service) sendDueReminders(ctx context.Context) {
	now := time.Now()
	if err := s.SendReminders(ctx, now); err != nil && ctx.Err() == nil {
		log.Printf("personal agent reminders: %v", err)
	}
	if err := s.SendDigests(ctx, now); err != nil && ctx.Err() == nil {
		log.Printf("personal agent digests: %v", err)
	}
	if err := s.archiveFinishedItems(ctx, now); err != nil && ctx.Err() == nil {
		log.Printf("personal agent items: archive finished: %v", err)
	}
}

// archiveFinishedItems is the time rule: the items closed long enough ago
// are archived, and so are their ended helper sessions, through the session
// archive path (ArchiveItemSessions). A session that cannot be archived
// comes back in the error, named by its item, and the rest of the sweep goes on.
func (s *Service) archiveFinishedItems(ctx context.Context, now time.Time) error {
	archived, err := s.store.SweepArchiveFinishedItems(ctx, now, itemArchiveAfter)
	if err != nil {
		return err
	}
	var failures []error
	for _, item := range archived {
		if len(item.SessionIDs) == 0 {
			continue
		}
		if s.archiveItemSessions == nil {
			failures = append(failures, fmt.Errorf("item %s: no port archives its helper sessions", item.ItemID))
			continue
		}
		if err := s.archiveItemSessions(ctx, store.PersonalAgentActorFoundry, item.AssistantID, item.ItemID, item.SessionIDs); err != nil {
			failures = append(failures, fmt.Errorf("item %s: %w", item.ItemID, err))
		}
	}
	return errors.Join(failures...)
}

// SendReminders tells the assistant of each item whose reminder
// is due, once, unless the assistant is stopped (it is then not sent).
func (s *Service) SendReminders(ctx context.Context, now time.Time) error {
	due, err := s.store.DuePersonalAgentReminders(ctx, now.UTC().Format(time.RFC3339))
	if err != nil {
		return err
	}
	for _, item := range due {
		agent, err := s.store.GetAssistant(ctx, item.AssistantID)
		if err != nil || agent.State != store.PersonalAgentActive {
			continue
		}
		conversation := cmp.Or(s.latestConversation(ctx, agent), item.SourceSessionID)
		if conversation == "" {
			continue
		}
		if claimed, err := s.store.ClaimPersonalAgentReminder(ctx, item.AssistantID, item.ID, item.At); err != nil || !claimed {
			continue
		}
		location := s.PersonLocation(ctx, agent)
		at, _ := time.Parse(time.RFC3339, item.At)
		text := s.sayList(ctx, agent, "reminder", at.In(location).Format("15:04"), item.Text,
			cmp.Or(item.When, s.sayList(ctx, agent, "noWhen")), item.ID)
		s.tell(ctx, conversation, store.NoticeKindReminder, text)
	}
	return nil
}

// digestWindow is how long after the person's digest time a digest still
// goes out (the server was down at the time); turned on later in the day,
// the first one goes out the next day.
const digestWindow = 2 * time.Hour

// SendDigests sends each active assistant whose person turned the
// daily digest on, once a day at their time, the facts for it: their list
// and the work it follows up. With nothing on record, nothing is sent.
func (s *Service) SendDigests(ctx context.Context, now time.Time) error {
	agents, err := s.store.ListPersonalAgents(ctx)
	if err != nil {
		return err
	}
	for _, agent := range agents {
		if !agent.Settings.DailyDigest || agent.State != store.PersonalAgentActive {
			continue
		}
		location := s.PersonLocation(ctx, agent)
		local := now.In(location)
		clock, err := time.ParseInLocation("15:04", cmp.Or(agent.Settings.DailyDigestTime, "09:00"), location)
		if err != nil {
			continue
		}
		due := time.Date(local.Year(), local.Month(), local.Day(), clock.Hour(), clock.Minute(), 0, 0, location)
		if local.Before(due) || !local.Before(due.Add(digestWindow)) {
			continue
		}
		facts, err := s.DigestFacts(ctx, agent, now)
		if err != nil {
			log.Printf("personal agent %s: digest facts: %v", agent.UserID, err)
			continue
		}
		if claimed, err := s.store.ClaimPersonalAgentDigest(ctx, agent.ID, local.Format(time.DateOnly)); err != nil || !claimed || facts == "" {
			continue
		}
		conversation := s.latestConversation(ctx, agent)
		if conversation == "" {
			continue
		}
		s.tell(ctx, conversation, store.NoticeKindDigest, s.sayList(ctx, agent, "digest", local.Format("2006-01-02 15:04"), facts))
	}
	return nil
}

// DigestFacts lists, for the digest, the person's open items, the items closed
// and the tasks open or ended in the last day; "" when there is none.
func (s *Service) DigestFacts(ctx context.Context, agent store.PersonalAgent, now time.Time) (string, error) {
	dayAgo := formatPATime(now.Add(-24 * time.Hour))
	items, err := s.digestItems(ctx, agent.ID, dayAgo)
	if err != nil {
		return "", err
	}
	s.RefreshTasks(ctx, agent)
	tasks, err := s.store.ListPersonalAgentTasks(ctx, agent.ID, nil)
	if err != nil {
		return "", err
	}
	location := s.PersonLocation(ctx, agent)
	var open, closed, running, ended []string
	for _, item := range items {
		line := item.Text
		if item.When != "" {
			line += s.sayList(ctx, agent, "when", item.When)
		}
		if at, err := time.Parse(time.RFC3339, item.At); err == nil {
			line += " " + at.In(location).Format("01-02 15:04")
		}
		switch item.Status {
		case store.PersonalAgentItemOpen:
			open = append(open, line)
		case store.PersonalAgentItemDropped:
			closed = append(closed, line+s.sayList(ctx, agent, "dropped"))
		default:
			closed = append(closed, line)
		}
	}
	for _, task := range tasks {
		switch {
		case task.Status == store.PersonalAgentTaskQueued || task.Status == store.PersonalAgentTaskRunning || task.Status == store.PersonalAgentTaskAsking:
			running = append(running, task.Title)
		case task.EndedAt >= dayAgo:
			ended = append(ended, task.Title+" ("+task.Status+")")
		}
	}
	var out strings.Builder
	for _, group := range []struct {
		key   string
		lines []string
	}{{"open", open}, {"closed", closed}, {"tasks", running}, {"tasksEnded", ended}} {
		if len(group.lines) == 0 {
			continue
		}
		out.WriteString(s.sayList(ctx, agent, group.key) + "\n- " + strings.Join(group.lines, "\n- ") + "\n")
	}
	return strings.TrimRight(out.String(), "\n"), nil
}

// digestItems are the person's items open or closed since closedSince, as the
// items page's query finds them (archived ones left out), read page by page.
func (s *Service) digestItems(ctx context.Context, assistantID, closedSince string) ([]store.PersonalAgentListItem, error) {
	var items []store.PersonalAgentListItem
	for offset := 0; ; {
		page, err := s.store.ListPersonalAgentItemPage(ctx, assistantID, store.PersonalAgentItemFilter{ClosedSince: closedSince, Limit: store.PersonalAgentItemPageMax, Offset: offset})
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
		if page.NextOffset == 0 {
			return items, nil
		}
		offset = page.NextOffset
	}
}

// MoveHelper ties one of scope's helpers to an open item of the person's
// list (send_message itemId). The assistant's helpers are its tasks: the item
// it leaves and the item it joins follow. A workspace session's helpers (the
// sessions it created) are tied by a link of their own, which does not make
// them the assistant's work.
func (s *Service) MoveHelper(ctx context.Context, scope Scope, sessionID, itemID string) error {
	item, err := s.HelperItem(ctx, scope, itemID)
	if err != nil {
		return err
	}
	if scope.Workspace != "" {
		if helper, err := s.store.GetAgentSessionSummary(ctx, sessionID); err != nil || helper.ParentSessionID != scope.SessionID {
			return invalid("session %s is not one of your helpers: only a session this session created can be tied to an item", sessionID)
		}
		return s.store.LinkPersonalAgentItemHelper(ctx, store.PersonalAgentActorSession, item.AssistantID, item.ID, sessionID)
	}
	tasks, err := s.store.ListPersonalAgentTasks(ctx, scope.Agent.ID, nil)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if task.SessionID == sessionID {
			return s.setTaskItem(ctx, task, itemID)
		}
	}
	return invalid("session %s is not one of your helpers: only helpers create_session started can be tied to an item", sessionID)
}
