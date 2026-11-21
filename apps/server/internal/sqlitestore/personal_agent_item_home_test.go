package sqlitestore

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An item's home was the plan's workspaceId. The start that adds
// home_workspace_id moves it there and out of the plan; from then on the plan
// shows the home but never stores it, and a later start moves nothing again.
func TestPersonalAgentItemHomeMigratesFromThePlan(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	routed, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Compare formats",
		Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready"}})
	if err != nil {
		t.Fatal(err)
	}
	unrouted, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Buy milk",
		Plan: &store.PersonalAgentItemPlan{Mode: "record", Progress: "inbox"}})
	if err != nil {
		t.Fatal(err)
	}
	bare, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Call mum"})
	if err != nil {
		t.Fatal(err)
	}
	// The old shape: the home lived in plan_json, no home or holder column.
	if _, err := db.conn().ExecContext(ctx, `UPDATE pa_items SET plan_json = json_set(plan_json, '$.workspaceId', 'ws_old') WHERE id = ?`, routed.ID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`DROP INDEX idx_pa_items_home`,
		`ALTER TABLE pa_items DROP COLUMN home_workspace_id`,
		`ALTER TABLE pa_items DROP COLUMN holder_session_id`,
	} {
		if _, err := db.conn().ExecContext(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	if err := db.setupPersonalAgentList(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetPersonalAgentItem(ctx, "asst_a", routed.ID)
	if err != nil || got.HomeWorkspaceID != "ws_old" || got.Plan == nil || got.Plan.WorkspaceID != "ws_old" || got.Plan.Mode != "execute" {
		t.Fatalf("migrated item = %+v (%v)", got, err)
	}
	var stored string
	if err := db.conn().QueryRowContext(ctx, `SELECT plan_json FROM pa_items WHERE id = ?`, routed.ID).Scan(&stored); err != nil || stored != `{"mode":"execute","progress":"ready"}` {
		t.Fatalf("the plan still stores the home: %s (%v)", stored, err)
	}
	for _, id := range []string{unrouted.ID, bare.ID} {
		if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", id); got.HomeWorkspaceID != "" {
			t.Fatalf("an item without a workspace got home %q", got.HomeWorkspaceID)
		}
	}

	// A save writes the home column and leaves the plan without it; a plan's
	// own workspaceId is not a second source.
	got.HomeWorkspaceID = ""
	got.Plan.WorkspaceID = "ws_stale"
	saved, err := db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, got)
	if err != nil || saved.HomeWorkspaceID != "" || saved.Plan.WorkspaceID != "" {
		t.Fatalf("saved = %+v (%v)", saved, err)
	}
	if err := db.conn().QueryRowContext(ctx, `SELECT plan_json FROM pa_items WHERE id = ?`, routed.ID).Scan(&stored); err != nil || stored != `{"mode":"execute","progress":"ready"}` {
		t.Fatalf("a save stored the plan's workspaceId: %s (%v)", stored, err)
	}
	events, _ := db.ListPersonalAgentItemEvents(ctx, "asst_a", routed.ID)
	last := events[len(events)-1]
	if last.Kind != store.PersonalAgentItemEventRehomed || last.Detail == nil || last.Detail.From != "ws_old" || last.Detail.To != "" || last.Actor != store.PersonalAgentActorPerson {
		t.Fatalf("rehomed event = %+v", last)
	}
	if after, _ := db.GetPersonalAgentItem(ctx, "asst_a", routed.ID); after.IntentRevision == got.IntentRevision {
		t.Fatalf("a new home did not change the intent revision: %d", after.IntentRevision)
	}
	if err := db.setupPersonalAgentList(ctx); err != nil {
		t.Fatal(err)
	}
	if again, _ := db.GetPersonalAgentItem(ctx, "asst_a", routed.ID); again.HomeWorkspaceID != "" {
		t.Fatalf("a later start moved the home again: %q", again.HomeWorkspaceID)
	}
}

// One session holds an item at a time: a claim replaces the holder and says
// whom; only the holder releases; a save keeps the holder.
func TestPersonalAgentItemHolder(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Ship the release", HomeWorkspaceID: "ws_a"})
	if err != nil {
		t.Fatal(err)
	}
	held, replaced, err := db.ClaimPersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", item.ID, "sess_one")
	if err != nil || held.HolderSessionID != "sess_one" || replaced != "" || held.Revision != item.Revision {
		t.Fatalf("first claim = %+v %q (%v)", held, replaced, err)
	}
	held, replaced, err = db.ClaimPersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", item.ID, "sess_two")
	if err != nil || held.HolderSessionID != "sess_two" || replaced != "sess_one" {
		t.Fatalf("second claim = %+v %q (%v)", held, replaced, err)
	}
	held.Summary = "two sessions so far"
	if saved, err := db.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{ID: held.ID, UserID: held.UserID, AssistantID: held.AssistantID,
		Text: held.Text, Status: held.Status, Summary: held.Summary, HomeWorkspaceID: held.HomeWorkspaceID}); err != nil || saved.HolderSessionID != "sess_two" {
		t.Fatalf("a save changed the holder: %+v (%v)", saved, err)
	}
	if _, released, err := db.ReleasePersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", item.ID, "sess_one"); err != nil || released {
		t.Fatalf("a session that no longer holds it released it (%v)", err)
	}
	after, released, err := db.ReleasePersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", item.ID, "sess_two")
	if err != nil || !released || after.HolderSessionID != "" {
		t.Fatalf("release = %+v %v (%v)", after, released, err)
	}
	var kinds []string
	events, _ := db.ListPersonalAgentItemEvents(ctx, "asst_a", item.ID)
	for _, event := range events {
		switch event.Kind {
		case store.PersonalAgentItemEventClaimed, store.PersonalAgentItemEventReleased:
			kinds = append(kinds, event.Kind+":"+event.Detail.SessionID+"<"+event.Detail.From)
		}
	}
	if want := []string{"claimed:sess_one<", "claimed:sess_two<sess_one", "released:sess_two<"}; !slices.Equal(kinds, want) {
		t.Fatalf("holder events = %v, want %v", kinds, want)
	}
}

// The person's ledger reads across their assistants; a workspace keeps the
// items homed there and those whose helpers run there.
func TestPersonalAgentItemPageByWorkspace(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	add := func(assistantID, text, home string) store.PersonalAgentListItem {
		t.Helper()
		item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: assistantID, Text: text, HomeWorkspaceID: home})
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	homed := add("asst_a", "Homed in ws_a", "ws_a")
	other := add("asst_b", "Homed in ws_a on the work assistant", "ws_a")
	touching := add("asst_a", "Homed in ws_b, helped in ws_a", "ws_b")
	add("asst_a", "Inbox", "")
	if _, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_b", AssistantID: "asst_c", Text: "Someone else's", HomeWorkspaceID: "ws_a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_a", SessionID: "sess_h", Title: "help", ItemID: touching.ID}); err != nil {
		t.Fatal(err)
	}
	page, err := db.ListPersonalAgentItemPage(ctx, "", store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewAll, UserID: "user_a", WorkspaceID: "ws_a"})
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, item := range page.Items {
		ids = append(ids, item.ID)
	}
	slices.Sort(ids)
	want := []string{homed.ID, other.ID, touching.ID}
	slices.Sort(want)
	if !slices.Equal(ids, want) || page.Total != 3 {
		t.Fatalf("ws_a items = %v (total %d), want %v", ids, page.Total, want)
	}
	if touches := store.ItemTouches(touching.HomeWorkspaceID, page.Helpers[touching.ID]); !slices.Equal(touches, []string{"ws_a"}) {
		t.Fatalf("touches = %v", touches)
	}
	if _, err := db.ListPersonalAgentItemPage(ctx, "", store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewAll}); err == nil {
		t.Fatal("a page with neither an assistant nor a person was answered")
	}
	if found, err := db.GetPersonalAgentItemOfUser(ctx, "user_a", other.ID); err != nil || found.AssistantID != "asst_b" {
		t.Fatalf("the person's item on another assistant = %+v (%v)", found, err)
	}
	if _, err := db.GetPersonalAgentItemOfUser(ctx, "user_b", other.ID); err == nil {
		t.Fatal("another person found the item")
	}
}

// Deleting a workspace, or purging the removed device it is on, returns the
// items homed there to the inbox and releases those its sessions hold, each
// recorded by Foundry, and tells the observer so the item files follow: both
// deletions let items go the same way. Items elsewhere are left alone.
func TestDeletedWorkspaceRehomesItsItems(t *testing.T) {
	for name, deleteHome := range map[string]func(context.Context, *Store) error{
		"workspace deleted": func(ctx context.Context, db *Store) error {
			_, err := db.DeleteWorkspace(ctx, "ws_home")
			return err
		},
		"device removed": func(ctx context.Context, db *Store) error {
			if _, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_home"}); err != nil {
				return err
			}
			_, err := db.PurgeRemovedDevice(ctx, "dev_home")
			return err
		},
	} {
		t.Run(name, func(t *testing.T) { testDeletedHomeRehomesItsItems(t, deleteHome) })
	}
}

func testDeletedHomeRehomesItsItems(t *testing.T, deleteHome func(context.Context, *Store) error) {
	db, ctx := newTestStore(t), context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "linux-dev")); err != nil {
		t.Fatal(err)
	}
	other := homeRegistration("dev_other", "other-dev")
	other.Workspace = store.WorkspaceProjection{ID: "ws_other", Name: "Other", LocalPath: "/home/me/Other", Baseline: "main"}
	other.Agents, other.Assets, other.Chats = nil, nil, nil
	if err := db.RegisterDaemon(ctx, other); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_home", AgentID: "agent_home", Provider: "claude", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "done", "native_home"); err != nil {
		t.Fatal(err)
	}
	add := func(text, home string) store.PersonalAgentListItem {
		t.Helper()
		item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: text, HomeWorkspaceID: home})
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	homed := add("Homed in ws_home", "ws_home")
	elsewhere := add("Homed in ws_other, held from ws_home", "ws_other")
	untouched := add("Homed in ws_other", "ws_other")
	if _, _, err := db.ClaimPersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", elsewhere.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	var changes []store.PersonalAgentItemChange
	db.ObservePersonalAgentItemChanges(func(change store.PersonalAgentItemChange) { changes = append(changes, change) })

	if err := deleteHome(ctx, db); err != nil {
		t.Fatal(err)
	}

	got, err := db.GetPersonalAgentItem(ctx, "asst_a", homed.ID)
	if err != nil || got.HomeWorkspaceID != "" || got.Revision != homed.Revision+1 || got.IntentRevision != homed.IntentRevision+1 {
		t.Fatalf("item of the deleted workspace = %+v (%v), want no home and a new revision", got, err)
	}
	events, _ := db.ListPersonalAgentItemEvents(ctx, "asst_a", homed.ID)
	last := events[len(events)-1]
	if last.Kind != store.PersonalAgentItemEventRehomed || last.Actor != store.PersonalAgentActorFoundry || last.Detail == nil || last.Detail.From != "ws_home" || last.Detail.To != "" {
		t.Fatalf("last event = %+v", last)
	}
	// A save read before the deletion cannot bring the deleted home back.
	if _, err := db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, homed); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("stale save = %v, want a revision conflict", err)
	}

	held, _ := db.GetPersonalAgentItem(ctx, "asst_a", elsewhere.ID)
	if held.HolderSessionID != "" || held.HomeWorkspaceID != "ws_other" {
		t.Fatalf("item held from the deleted workspace = %+v", held)
	}
	events, _ = db.ListPersonalAgentItemEvents(ctx, "asst_a", elsewhere.ID)
	if last := events[len(events)-1]; last.Kind != store.PersonalAgentItemEventReleased || last.Actor != store.PersonalAgentActorFoundry || last.Detail == nil || last.Detail.SessionID != session.ID {
		t.Fatalf("last event of the held item = %+v", last)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, "asst_a", untouched.ID); got.Revision != untouched.Revision || got.HomeWorkspaceID != "ws_other" {
		t.Fatalf("an item elsewhere changed: %+v", got)
	}

	told := map[string][]string{}
	for _, change := range changes {
		told[change.ItemID] = append(told[change.ItemID], change.Workspaces...)
	}
	if !slices.Contains(told[homed.ID], "ws_home") || !slices.Contains(told[elsewhere.ID], "ws_other") || len(told[untouched.ID]) != 0 {
		t.Fatalf("observed changes = %v", told)
	}
}

// A helper linked to an item (pa_item_helpers) is one of the item's helpers
// beside its tasks, a session once: it shows in the item's helpers, makes the
// item touch its workspace, and records helper_started when it joins and
// helper_ended once when its session ends; working again records nothing but
// still tells the observer.
func TestLinkedHelpersAreTheItemsHelpers(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "linux-dev")); err != nil {
		t.Fatal(err)
	}
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Homed in ws_far", HomeWorkspaceID: "ws_far"})
	if err != nil {
		t.Fatal(err)
	}
	task := store.AgentSession{ID: "sess_task"}
	if _, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: "asst_a", WorkspaceID: "ws_far", SessionID: task.ID, Title: "task", ItemID: item.ID}); err != nil {
		t.Fatal(err)
	}
	linked, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_home", AgentID: "agent_home", Provider: "claude", Prompt: "help"})
	if err != nil {
		t.Fatal(err)
	}
	var told int
	db.ObservePersonalAgentItemChanges(func(change store.PersonalAgentItemChange) {
		if change.ItemID == item.ID {
			told++
		}
	})
	for _, sessionID := range []string{linked.ID, linked.ID, task.ID} {
		if err := db.LinkPersonalAgentItemHelper(ctx, store.PersonalAgentActorSession, "asst_a", item.ID, sessionID); err != nil {
			t.Fatal(err)
		}
	}

	helpers, err := db.ListPersonalAgentItemHelpers(ctx, "asst_a", item.ID)
	if err != nil || len(helpers) != 2 || helpers[0].SessionID != task.ID || helpers[1].SessionID != linked.ID ||
		helpers[1].WorkspaceID != "ws_home" || helpers[1].Status != store.PersonalAgentTaskRunning {
		t.Fatalf("helpers = %+v (%v), want the task and the linked helper once each", helpers, err)
	}
	if touches := store.ItemTouches(item.HomeWorkspaceID, helpers); !slices.Equal(touches, []string{"ws_home"}) {
		t.Fatalf("touches = %v", touches)
	}
	page, err := db.ListPersonalAgentItemPage(ctx, "", store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewAll, UserID: "user_a", WorkspaceID: "ws_home"})
	if err != nil || len(page.Items) != 1 || len(page.Helpers[item.ID]) != 2 {
		t.Fatalf("ws_home page = %+v (%v)", page, err)
	}

	for _, status := range []string{store.PersonalAgentTaskDone, store.PersonalAgentTaskDone} {
		if err := db.SetPersonalAgentItemHelperStatus(ctx, linked.ID, status, "2026-11-21T01:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}
	before := told
	if err := db.SetPersonalAgentItemHelperStatus(ctx, linked.ID, store.PersonalAgentTaskRunning, ""); err != nil {
		t.Fatal(err)
	}
	if told != before+1 {
		t.Fatal("working again did not tell the observer")
	}
	if err := db.SetPersonalAgentItemHelperStatus(ctx, "sess_unlinked", store.PersonalAgentTaskDone, ""); err != nil {
		t.Fatal(err)
	}

	events, _ := db.ListPersonalAgentItemEvents(ctx, "asst_a", item.ID)
	var kinds []string
	for _, event := range events {
		if event.Detail != nil && event.Detail.SessionID == linked.ID {
			kinds = append(kinds, event.Kind+":"+event.Actor+":"+event.Detail.To)
		}
	}
	if want := []string{"helper_started:session:", "helper_ended:foundry:done"}; !slices.Equal(kinds, want) {
		t.Fatalf("linked helper events = %v, want %v", kinds, want)
	}
	helpers, _ = db.ListPersonalAgentItemHelpers(ctx, "asst_a", item.ID)
	if helpers[1].Status != store.PersonalAgentTaskRunning || helpers[1].EndedAt != "" {
		t.Fatalf("the linked helper working again = %+v", helpers[1])
	}
}
