package sqlitestore

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setItemTimes moves an item's times, which the tests put in the past.
func setItemTimes(t *testing.T, db *Store, id, createdAt, updatedAt, closedAt string) {
	t.Helper()
	if _, err := db.conn().ExecContext(context.Background(), `UPDATE pa_items SET created_at = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
		createdAt, updatedAt, closedAt, id); err != nil {
		t.Fatal(err)
	}
}

// An old-shape database has pa_items.task_id and neither the owner, summary,
// origin nor archive columns, and pa_tasks no item_id. Its first start gives
// the items that had a task to the assistant and links each task to its
// item; a later start backfills nothing again.
func TestPersonalAgentItemsMigrationBackfillsOnce(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	helped, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Check the deploy"})
	if err != nil {
		t.Fatal(err)
	}
	alone, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Buy milk"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_deploy", Title: "deploy check"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `UPDATE pa_items SET task_id = ? WHERE id = ?`, task.ID, helped.ID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`DROP INDEX idx_pa_tasks_item`,
		`ALTER TABLE pa_tasks DROP COLUMN item_id`,
		`ALTER TABLE pa_items DROP COLUMN owner`,
		`ALTER TABLE pa_items DROP COLUMN summary`,
		`ALTER TABLE pa_items DROP COLUMN origin_json`,
		`ALTER TABLE pa_items DROP COLUMN archived_at`,
	} {
		if _, err := db.conn().ExecContext(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}

	if err := db.setupPersonalAgentList(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", helped.ID); got.Owner != store.PersonalAgentItemOwnerAssistant {
		t.Fatalf("an item with a task is the assistant's: %+v", got)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", alone.ID); got.Owner != store.PersonalAgentItemOwnerPerson {
		t.Fatalf("an item without a task is the person's: %+v", got)
	}
	if tasks, _ := db.ListPersonalAgentTasks(ctx, "asst_a", nil); len(tasks) != 1 || tasks[0].ItemID != helped.ID {
		t.Fatalf("the task names its item: %+v", tasks)
	}

	if _, err := db.conn().ExecContext(ctx, `UPDATE pa_items SET owner = ? WHERE id = ?`, store.PersonalAgentItemOwnerPerson, helped.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `UPDATE pa_tasks SET item_id = '' WHERE id = ?`, task.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.setupPersonalAgentList(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", helped.ID); got.Owner != store.PersonalAgentItemOwnerPerson {
		t.Fatalf("a later start backfilled the owner again: %+v", got)
	}
	if tasks, _ := db.ListPersonalAgentTasks(ctx, "asst_a", nil); len(tasks) != 1 || tasks[0].ItemID != "" {
		t.Fatalf("a later start linked the task again: %+v", tasks)
	}
}

// Each change lands on the item's timeline with who made it, and helpers
// join and end on it.
func TestPersonalAgentItemEventsRecordWhoChangedWhat(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Reply to QA"})
	if err != nil {
		t.Fatal(err)
	}
	item.Text = "Reply to QA about the build"
	if item, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, item); err != nil {
		t.Fatal(err)
	}
	item.Owner = store.PersonalAgentItemOwnerAssistant
	if item, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, item); err != nil {
		t.Fatal(err)
	}
	item.Summary = "Asked QA for the build; waiting"
	if item, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item); err != nil {
		t.Fatal(err)
	}
	helper, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_qa", Title: "reply to QA", ItemID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	helper.Status = store.PersonalAgentTaskDone
	if err := db.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorFoundry, helper); err != nil {
		t.Fatal(err)
	}
	item.Status = store.PersonalAgentItemDone
	if item, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, item); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", item.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", item.ID, false); err != nil {
		t.Fatal(err)
	}

	events, err := db.ListPersonalAgentItemEvents(ctx, "asst_a", item.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct{ kind, actor string }{
		{store.PersonalAgentItemEventCreated, store.PersonalAgentActorAssistant},
		{store.PersonalAgentItemEventEdited, store.PersonalAgentActorPerson},
		{store.PersonalAgentItemEventOwnerChanged, store.PersonalAgentActorPerson},
		{store.PersonalAgentItemEventSummaryUpdated, store.PersonalAgentActorAssistant},
		{store.PersonalAgentItemEventHelperStarted, store.PersonalAgentActorAssistant},
		{store.PersonalAgentItemEventHelperEnded, store.PersonalAgentActorFoundry},
		{store.PersonalAgentItemEventStatusChanged, store.PersonalAgentActorPerson},
		{store.PersonalAgentItemEventArchived, store.PersonalAgentActorPerson},
		{store.PersonalAgentItemEventRestored, store.PersonalAgentActorPerson},
	}
	if len(events) != len(want) {
		t.Fatalf("events = %+v, want %d", events, len(want))
	}
	for index, event := range events {
		if event.Kind != want[index].kind || event.Actor != want[index].actor {
			t.Fatalf("event %d = %s by %s, want %s by %s", index, event.Kind, event.Actor, want[index].kind, want[index].actor)
		}
	}
	ended := events[5]
	if ended.Detail == nil || ended.Detail.SessionID != "sess_qa" || ended.Detail.To != store.PersonalAgentTaskDone || ended.Detail.Title != "reply to QA" {
		t.Fatalf("helper_ended detail = %+v", ended.Detail)
	}
	if events[2].Detail == nil || events[2].Detail.From != store.PersonalAgentItemOwnerPerson || events[2].Detail.To != store.PersonalAgentItemOwnerAssistant {
		t.Fatalf("owner_changed detail = %+v", events[2].Detail)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", item.ID); got.ArchivedAt != "" {
		t.Fatalf("restore kept archived_at: %+v", got)
	}
	if _, err := db.SavePersonalAgentItem(ctx, "someone", item); err == nil {
		t.Fatal("an unknown actor was accepted")
	}
}

// A summary holds at most 1500 characters, counted as characters.
func TestPersonalAgentItemSummaryLimit(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Write it up", Summary: strings.Repeat("字", store.PersonalAgentItemSummaryMaxLength)})
	if err != nil {
		t.Fatalf("a summary at the limit: %v", err)
	}
	item.Summary = strings.Repeat("字", store.PersonalAgentItemSummaryMaxLength+1)
	if _, err := db.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item); !errors.Is(err, store.ErrPersonalAgentItemInvalid) {
		t.Fatalf("a long summary saved: %v", err)
	}
	if _, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Too long", Summary: item.Summary}); !errors.Is(err, store.ErrPersonalAgentItemInvalid) {
		t.Fatalf("a long summary added: %v", err)
	}
}

// Archive waits until the item is closed and its helpers are no longer
// running, then archives and restores with a timeline event each.
func TestPersonalAgentItemArchiveRules(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Check the build"})
	if err != nil {
		t.Fatal(err)
	}
	helper, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_build", Title: "build", ItemID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	item.Status = store.PersonalAgentItemDone
	if item, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, item); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", item.ID, true); !errors.Is(err, store.ErrPersonalAgentItemNotArchivable) {
		t.Fatalf("archived while its helper runs: %v", err)
	}
	helper.Status = store.PersonalAgentTaskDone
	if err := db.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorFoundry, helper); err != nil {
		t.Fatal(err)
	}
	sessions, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", item.ID, true)
	if err != nil || len(sessions) != 1 || sessions[0] != "sess_build" {
		t.Fatalf("archive with an ended helper = %v (%v)", sessions, err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", item.ID); got.ArchivedAt == "" {
		t.Fatal("archived_at not set")
	}
	open, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Still open"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", open.ID, true); !errors.Is(err, store.ErrPersonalAgentItemNotArchivable) {
		t.Fatalf("an open item archived: %v", err)
	}
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", item.ID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", item.ID); got.ArchivedAt != "" {
		t.Fatalf("restore kept archived_at: %+v", got)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", item.ID); got.ArchivedAt != "" || got.Status != store.PersonalAgentItemDone {
		t.Fatalf("restored item = %+v", got)
	}
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", item.ID, true); err != nil {
		t.Fatal(err)
	}
	reopened, err := db.GetPersonalAgentItem(ctx, "asst_a", item.ID)
	if err != nil {
		t.Fatal(err)
	}
	reopened.Status = store.PersonalAgentItemOpen
	if reopened, err = db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, reopened); err != nil || reopened.ArchivedAt != "" {
		t.Fatalf("reopening kept the archive: %+v (%v)", reopened, err)
	}
}

// The items page filters by view, owner and range, searches, pages and
// attaches the helpers of the items on the page.
func TestPersonalAgentItemPageFiltersAndPages(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	const day = "2026-11-16T"
	deploy, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Check llm-gateway", Summary: "Asked the deploy session; waiting for the log", Owner: store.PersonalAgentItemOwnerAssistant})
	if err != nil {
		t.Fatal(err)
	}
	renew, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorPerson, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Renew the domain"})
	if err != nil {
		t.Fatal(err)
	}
	bank, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorPerson, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Call the bank", Status: store.PersonalAgentItemDone})
	if err != nil {
		t.Fatal(err)
	}
	old, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Old experiment", Status: store.PersonalAgentItemDropped})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_b", AssistantID: "asst_b", Text: "Someone else's"}); err != nil {
		t.Fatal(err)
	}
	setItemTimes(t, db, deploy.ID, day+"00:00:00Z", day+"09:00:00Z", "")
	setItemTimes(t, db, renew.ID, "2026-11-10T00:00:00Z", "2026-11-10T10:00:00Z", "")
	setItemTimes(t, db, bank.ID, "2026-11-12T00:00:00Z", "2026-11-12T10:00:00Z", "2026-11-12T10:00:00Z")
	setItemTimes(t, db, old.ID, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "2026-11-02T00:00:00Z")
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", old.ID, true); err != nil {
		t.Fatal(err)
	}
	helper, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_gateway", Title: "gateway deploy", ItemID: deploy.ID})
	if err != nil {
		t.Fatal(err)
	}

	ids := func(page store.PersonalAgentItemPage) []string {
		var out []string
		for _, item := range page.Items {
			out = append(out, item.ID)
		}
		return out
	}
	page, err := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{})
	if err != nil || len(ids(page)) != 2 || ids(page)[0] != deploy.ID || ids(page)[1] != renew.ID || page.Total != 2 || page.NextOffset != 0 {
		t.Fatalf("open items = %+v (%v)", page, err)
	}
	if len(page.Helpers[deploy.ID]) != 1 || page.Helpers[deploy.ID][0].ID != helper.ID || len(page.Helpers[renew.ID]) != 0 {
		t.Fatalf("helpers = %+v", page.Helpers)
	}
	if finished, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewFinished}); len(ids(finished)) != 1 || ids(finished)[0] != bank.ID {
		t.Fatalf("finished items = %+v", finished)
	}
	if archived, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewArchived}); len(ids(archived)) != 1 || ids(archived)[0] != old.ID {
		t.Fatalf("archived items = %+v", archived)
	}
	if assistantOwned, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{Owner: store.PersonalAgentItemOwnerAssistant}); len(ids(assistantOwned)) != 1 || ids(assistantOwned)[0] != deploy.ID {
		t.Fatalf("owned by the assistant = %+v", assistantOwned)
	}
	if byText, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{Query: "GATEWAY"}); len(ids(byText)) != 1 || ids(byText)[0] != deploy.ID {
		t.Fatalf("a text search = %+v", byText)
	}
	if bySummary, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{Query: "waiting FOR the log"}); len(ids(bySummary)) != 1 || ids(bySummary)[0] != deploy.ID {
		t.Fatalf("a summary search = %+v", bySummary)
	}
	if none, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{Query: "%"}); len(ids(none)) != 0 {
		t.Fatalf("a wildcard matched = %+v", none)
	}
	if inRange, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewFinished, From: "2026-11-12T10:00:00Z", To: "2026-11-12T10:00:00Z"}); len(ids(inRange)) != 0 {
		t.Fatalf("the range is [from, to) = %+v", inRange)
	}
	setItemTimes(t, db, renew.ID, "2026-11-10T00:00:00Z", "2026-11-16T09:00:00.5Z", "")
	if before, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{To: "2026-11-16T09:00:00Z"}); len(ids(before)) != 0 {
		t.Fatalf("an update after the end of the range fell inside it = %+v", before)
	}
	setItemTimes(t, db, deploy.ID, day+"00:00:00Z", day+"09:00:00Z", "")
	if inDay, _ := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{From: day + "00:00:00Z", To: "2026-11-17T00:00:00Z"}); len(ids(inDay)) != 2 {
		t.Fatalf("the day = %+v", inDay)
	}
	setItemTimes(t, db, renew.ID, "2026-11-10T00:00:00Z", "2026-11-10T10:00:00Z", "")
	if _, err := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{From: "yesterday"}); !errors.Is(err, store.ErrPersonalAgentItemInvalid) {
		t.Fatalf("a bad from: %v", err)
	}
	if _, err := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{View: "waiting"}); !errors.Is(err, store.ErrPersonalAgentItemInvalid) {
		t.Fatalf("a bad view: %v", err)
	}
	first, err := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{Limit: 1})
	if err != nil || len(ids(first)) != 1 || first.Total != 2 || first.NextOffset != 1 {
		t.Fatalf("first page = %+v (%v)", first, err)
	}
	second, err := db.ListPersonalAgentItemPage(ctx, "asst_a", store.PersonalAgentItemFilter{Limit: 1, Offset: first.NextOffset})
	if err != nil || len(ids(second)) != 1 || ids(second)[0] != renew.ID || second.NextOffset != 0 {
		t.Fatalf("second page = %+v (%v)", second, err)
	}
	if other, _ := db.ListPersonalAgentItemPage(ctx, "asst_b", store.PersonalAgentItemFilter{}); other.Total != 1 {
		t.Fatalf("another assistant's items = %+v", other)
	}
}

// The report counts a fixed range from items and their times alone.
func TestPersonalAgentItemReportCountsRange(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	add := func(text, status string) store.PersonalAgentListItem {
		item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: text, Status: status})
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	finished := add("Finished in range", store.PersonalAgentItemDone)
	setItemTimes(t, db, finished.ID, "2026-11-11T00:00:00Z", "2026-11-12T10:00:00Z", "2026-11-12T10:00:00Z")
	dropped := add("Dropped in range", store.PersonalAgentItemDropped)
	setItemTimes(t, db, dropped.ID, "2026-11-09T00:00:00Z", "2026-11-13T10:00:00Z", "2026-11-13T10:00:00Z")
	if _, err := db.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, "asst_a", dropped.ID, true); err != nil {
		t.Fatal(err)
	}
	open := add("Open in range", store.PersonalAgentItemOpen)
	setItemTimes(t, db, open.ID, "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z", "")
	stale := add("Open since before", store.PersonalAgentItemOpen)
	setItemTimes(t, db, stale.ID, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "")
	closedAfter := add("Done after the range", store.PersonalAgentItemDone)
	setItemTimes(t, db, closedAfter.ID, "2026-11-14T00:00:00Z", "2026-11-18T10:00:00Z", "2026-11-18T10:00:00Z")

	report, err := db.ReportPersonalAgentItems(ctx, "asst_a", "2026-11-10T00:00:00Z", "2026-11-17T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if report.Counts.Created != 3 || report.Counts.Done != 1 || report.Counts.Dropped != 1 || report.Counts.Open != 3 {
		t.Fatalf("counts = %+v", report.Counts)
	}
	groups := map[string][]string{}
	for _, group := range report.Groups {
		for _, item := range group.Items {
			groups[group.Status] = append(groups[group.Status], item.ID)
		}
	}
	if len(groups[store.PersonalAgentItemOpen]) != 1 || groups[store.PersonalAgentItemOpen][0] != open.ID {
		t.Fatalf("open group = %v", groups[store.PersonalAgentItemOpen])
	}
	if len(groups[store.PersonalAgentItemDone]) != 2 || len(groups[store.PersonalAgentItemDropped]) != 1 {
		t.Fatalf("groups = %v", groups)
	}
	if _, err := db.ReportPersonalAgentItems(ctx, "asst_a", "2026-11-17T00:00:00Z", "2026-11-10T00:00:00Z"); !errors.Is(err, store.ErrPersonalAgentItemInvalid) {
		t.Fatalf("a backwards range: %v", err)
	}
}

// The time rule archives the items closed at least 7 days ago with no helper
// running, as Foundry, and names the sessions of their ended helpers.
func TestPersonalAgentItemSweepArchivesFinishedItems(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	base := time.Now().UTC()
	closedAt := func(days int) string { return base.Add(-time.Duration(days) * 24 * time.Hour).Format(time.RFC3339Nano) }
	add := func(text, status string) store.PersonalAgentListItem {
		item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: text, Status: status})
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	old := add("Closed long ago", store.PersonalAgentItemDone)
	setItemTimes(t, db, old.ID, closedAt(8), closedAt(8), closedAt(8))
	recent := add("Closed yesterday", store.PersonalAgentItemDone)
	setItemTimes(t, db, recent.ID, closedAt(1), closedAt(1), closedAt(1))
	withHelper := add("Helper still running", store.PersonalAgentItemDropped)
	setItemTimes(t, db, withHelper.ID, closedAt(9), closedAt(9), closedAt(9))
	if _, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_running", Title: "still going", ItemID: withHelper.ID}); err != nil {
		t.Fatal(err)
	}
	ended := add("Helper ended", store.PersonalAgentItemDone)
	setItemTimes(t, db, ended.ID, closedAt(10), closedAt(10), closedAt(10))
	endedHelper, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_ended", Title: "done work", ItemID: ended.ID, Status: store.PersonalAgentTaskDone})
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	archived, err := db.SweepArchiveFinishedItems(ctx, now, 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(archived) != 2 {
		t.Fatalf("archived = %+v, want the two closed long ago", archived)
	}
	byItem := map[string][]string{}
	for _, item := range archived {
		byItem[item.ItemID] = item.SessionIDs
	}
	if _, ok := byItem[old.ID]; !ok || len(byItem[old.ID]) != 0 {
		t.Fatalf("the item closed long ago = %v", byItem)
	}
	if sessions := byItem[ended.ID]; len(sessions) != 1 || sessions[0] != endedHelper.SessionID {
		t.Fatalf("the ended helper's session = %v", sessions)
	}
	for _, id := range []string{old.ID, ended.ID} {
		events, _ := db.ListPersonalAgentItemEvents(ctx, "asst_a", id)
		if last := events[len(events)-1]; last.Kind != store.PersonalAgentItemEventArchived || last.Actor != store.PersonalAgentActorFoundry {
			t.Fatalf("the last event of %s = %+v", id, last)
		}
	}
	for _, id := range []string{recent.ID, withHelper.ID} {
		if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", id); got.ArchivedAt != "" {
			t.Fatalf("%s archived: %+v", id, got)
		}
	}
	if again, _ := db.SweepArchiveFinishedItems(ctx, now, 7*24*time.Hour); len(again) != 0 {
		t.Fatalf("a second sweep archived %+v", again)
	}
}

// A save and an archive in one call are all or nothing: an archive the item
// cannot take, and a save the store refuses, leave the item as it was.
func TestPersonalAgentItemSaveAndArchiveAreAllOrNothing(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Check the build"})
	if err != nil {
		t.Fatal(err)
	}
	stored := func() store.PersonalAgentListItem {
		t.Helper()
		got, err := db.GetPersonalAgentItem(ctx, "asst_a", item.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	open := item
	open.Text = "Check the build twice"
	if _, _, err := db.SavePersonalAgentItemArchive(ctx, store.PersonalAgentActorPerson, open, true); !errors.Is(err, store.ErrPersonalAgentItemNotArchivable) {
		t.Fatalf("archived an open item: %v", err)
	}
	if got := stored(); got.Text != "Check the build" || got.ArchivedAt != "" {
		t.Fatalf("a refused archive saved the text: %+v", got)
	}

	stale := item
	stale.Text, stale.Status, stale.Revision = "Check the build twice", store.PersonalAgentItemDone, item.Revision+5
	if _, _, err := db.SavePersonalAgentItemArchive(ctx, store.PersonalAgentActorPerson, stale, true); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("saved over a stale revision: %v", err)
	}
	if got := stored(); got.Text != "Check the build" || got.Status != store.PersonalAgentItemOpen || got.ArchivedAt != "" {
		t.Fatalf("a refused save changed or archived the item: %+v", got)
	}

	closed := item
	closed.Text, closed.Status = "Check the build twice", store.PersonalAgentItemDone
	saved, sessions, err := db.SavePersonalAgentItemArchive(ctx, store.PersonalAgentActorPerson, closed, true)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Text != "Check the build twice" || saved.ArchivedAt == "" || len(sessions) != 0 {
		t.Fatalf("saved = %+v, sessions = %v", saved, sessions)
	}
}

// Deleting an item takes its timeline with it and unlinks its helpers.
func TestPersonalAgentItemDeleteTakesItsTimeline(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Temporary"})
	if err != nil {
		t.Fatal(err)
	}
	helper, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_tmp", Title: "tmp", ItemID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePersonalAgentItem(ctx, "asst_a", item.ID); err != nil {
		t.Fatal(err)
	}
	if events, _ := db.ListPersonalAgentItemEvents(ctx, "asst_a", item.ID); len(events) != 0 {
		t.Fatalf("events of a deleted item = %+v", events)
	}
	if tasks, _ := db.ListPersonalAgentTasks(ctx, "asst_a", nil); len(tasks) != 1 || tasks[0].ID != helper.ID || tasks[0].ItemID != "" {
		t.Fatalf("the helper after delete = %+v", tasks)
	}
}
