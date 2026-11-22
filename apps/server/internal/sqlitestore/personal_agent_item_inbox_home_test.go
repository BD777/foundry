package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An item homed in its assistant's own workspace is in the inbox: one
// meaning, stored as "". A write normalizes it; the one-time migration moves
// the rows written before, changing nothing else about them.
func TestPersonalAgentItemHomeInTheAssistantsWorkspaceIsTheInbox(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	agent, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_assistant", HomeDeviceID: "dev_home"})
	if err != nil {
		t.Fatal(err)
	}
	added, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: agent.ID, Text: "Added at home", HomeWorkspaceID: "ws_assistant"})
	if err != nil {
		t.Fatal(err)
	}
	if added.HomeWorkspaceID != "" {
		t.Fatalf("added item home = %q, want the inbox", added.HomeWorkspaceID)
	}
	project, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: agent.ID, Text: "In a project", HomeWorkspaceID: "ws_project"})
	if err != nil || project.HomeWorkspaceID != "ws_project" {
		t.Fatalf("project item = %+v (%v)", project, err)
	}
	project.HomeWorkspaceID = "ws_assistant"
	saved, err := db.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, project)
	if err != nil || saved.HomeWorkspaceID != "" {
		t.Fatalf("item moved to the assistant's workspace = %+v (%v)", saved, err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, agent.ID, project.ID); got.HomeWorkspaceID != "" {
		t.Fatalf("stored home = %q", got.HomeWorkspaceID)
	}

	// A workspace filter on the assistant's own workspace is its inbox.
	page, err := db.ListPersonalAgentItemPage(ctx, "", store.PersonalAgentItemFilter{View: store.PersonalAgentItemViewAll, UserID: "user_a", WorkspaceID: "ws_assistant"})
	if err != nil || page.Total != 2 {
		t.Fatalf("items of the assistant's workspace = %+v (%v), want its 2 inbox items", page.Items, err)
	}

	// Rows written before the normalization.
	stale, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: agent.ID, Text: "Written before", HomeWorkspaceID: "ws_project"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `UPDATE pa_items SET home_workspace_id = 'ws_assistant' WHERE id = ?`, stale.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `DELETE FROM data_migrations WHERE name = ?`, itemAssistantHomeMigration); err != nil {
		t.Fatal(err)
	}
	var before, after string
	columns := `text || '|' || revision || '|' || intent_revision || '|' || updated_at || '|' || status || '|' || plan_json`
	if err := db.conn().QueryRowContext(ctx, `SELECT `+columns+` FROM pa_items WHERE id = ?`, stale.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := db.migrateItemAssistantHomes(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, agent.ID, stale.ID); got.HomeWorkspaceID != "" {
		t.Fatalf("migrated home = %q, want the inbox", got.HomeWorkspaceID)
	}
	if err := db.conn().QueryRowContext(ctx, `SELECT `+columns+` FROM pa_items WHERE id = ?`, stale.ID).Scan(&after); err != nil || after != before {
		t.Fatalf("the migration changed more than the home: %q -> %q (%v)", before, after, err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, agent.ID, project.ID); got.HomeWorkspaceID != "" {
		t.Fatal("a moved item came back")
	}
	// Recorded: a later start leaves a row homed there alone.
	if _, err := db.conn().ExecContext(ctx, `UPDATE pa_items SET home_workspace_id = 'ws_assistant' WHERE id = ?`, stale.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.migrateItemAssistantHomes(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.GetPersonalAgentItem(ctx, agent.ID, stale.ID); got.HomeWorkspaceID != "ws_assistant" {
		t.Fatalf("the migration ran twice: home = %q", got.HomeWorkspaceID)
	}
}
