package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func digestRecord(userID, workspaceID, contentRev, due string) store.WorkspaceDigestRecord {
	return store.WorkspaceDigestRecord{
		Digest:       store.WorkspaceDigest{UserID: userID, WorkspaceID: workspaceID, Name: "Foundry", SourceRev: "src_" + contentRev, CompiledAt: "2026-10-15T00:00:00Z", LastActivityAt: "2026-10-14T00:00:00Z"},
		ContentRev:   contentRev,
		FilesRev:     "files",
		SummaryDueAt: due,
	}
}

func newDigestStore(t *testing.T) (*Store, string) {
	t.Helper()
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "linux-dev")); err != nil {
		t.Fatal(err)
	}
	user, err := db.CreateUser(ctx, store.NewUser{Username: "alice", PasswordHash: "h", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceMember(ctx, "ws_home", user.ID, store.WorkspaceRoleMember, "test"); err != nil {
		t.Fatal(err)
	}
	return db, user.ID
}

// A digest keeps its summary, intro and running summary across saves of
// the deterministic part, and its due time unless what it summarizes
// changed.
func TestWorkspaceDigestSummaryLoop(t *testing.T) {
	db, userID := newDigestStore(t)
	ctx := context.Background()
	if err := db.SaveWorkspaceDigest(ctx, digestRecord(userID, "ws_home", "rev1", "2026-10-15T00:00:00Z")); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveWorkspaceDigestIntro(ctx, "ws_home", "files", "Tracks spending."); err != nil {
		t.Fatal(err)
	}
	due, err := db.DueWorkspaceDigests(ctx, "2026-10-15T01:00:00Z", 10)
	if err != nil || len(due) != 1 || !due[0].Digest.Dirty || due[0].Digest.Intro != "Tracks spending." || due[0].NeedsIntro() {
		t.Fatalf("due = %+v, %v", due, err)
	}
	if claimed, err := db.ClaimWorkspaceDigestSummary(ctx, userID, "ws_home", "sess_1", "rev1"); err != nil || !claimed {
		t.Fatalf("claim = %v, %v", claimed, err)
	}
	if claimed, _ := db.ClaimWorkspaceDigestSummary(ctx, userID, "ws_home", "sess_2", "rev1"); claimed {
		t.Fatal("a second summary session claimed a running one")
	}
	// A change while it runs is due again after it.
	if err := db.SaveWorkspaceDigest(ctx, digestRecord(userID, "ws_home", "rev2", "2026-10-15T02:00:00Z")); err != nil {
		t.Fatal(err)
	}
	if err := db.FinishWorkspaceDigestSummary(ctx, userID, "ws_home", "sess_1", &store.WorkspaceDigestSummary{L0: "Budget page", Summary: "A page.", RouteWhen: []string{"spending"}}, "rev1", "2026-10-15T01:00:00Z", "2026-10-15T07:00:00Z"); err != nil {
		t.Fatal(err)
	}
	records, err := db.ListWorkspaceDigests(ctx, userID)
	if err != nil || len(records) != 1 {
		t.Fatalf("records = %+v, %v", records, err)
	}
	record := records[0]
	if record.Digest.L0 != "Budget page" || record.Digest.RouteWhen[0] != "spending" || !record.Digest.Dirty || record.SummaryDueAt != "2026-10-15T07:00:00Z" || record.SummarySessionID != "" {
		t.Fatalf("after a summary of an older revision: %+v", record)
	}
	if found, err := db.WorkspaceDigestForSummarySession(ctx, "sess_1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("finished session still found: %+v, %v", found, err)
	}
	// Saving the same content keeps the due time; new content sets it.
	if err := db.SaveWorkspaceDigest(ctx, digestRecord(userID, "ws_home", "rev2", "")); err != nil {
		t.Fatal(err)
	}
	records, _ = db.ListWorkspaceDigests(ctx, userID)
	if records[0].SummaryDueAt != "2026-10-15T07:00:00Z" || records[0].Digest.L0 != "Budget page" {
		t.Fatalf("an unchanged save moved the due time or lost the summary: %+v", records[0])
	}
	// Files gone: the intro goes with them.
	gone := digestRecord(userID, "ws_home", "rev2", "")
	gone.FilesRev = ""
	if err := db.SaveWorkspaceDigest(ctx, gone); err != nil {
		t.Fatal(err)
	}
	records, _ = db.ListWorkspaceDigests(ctx, userID)
	if records[0].Digest.Intro != "" {
		t.Fatalf("intro kept without its files: %q", records[0].Digest.Intro)
	}
}

// Losing access deletes the person's digest: removed from the workspace,
// or the workspace deleted.
func TestWorkspaceDigestGoesWithItsMembership(t *testing.T) {
	db, userID := newDigestStore(t)
	ctx := context.Background()
	if err := db.SaveWorkspaceDigest(ctx, digestRecord(userID, "ws_home", "rev1", "")); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveWorkspaceDigest(ctx, digestRecord("usr_stranger", "ws_home", "rev1", "")); err == nil {
		t.Fatal("saved a digest for someone who is not a member")
	}
	if err := db.RemoveWorkspaceMember(ctx, "ws_home", userID); err != nil {
		t.Fatal(err)
	}
	if records, _ := db.ListWorkspaceDigests(ctx, userID); len(records) != 0 {
		t.Fatalf("digest kept after removal: %+v", records)
	}

	if err := db.SetWorkspaceMember(ctx, "ws_home", userID, store.WorkspaceRoleMember, "test"); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveWorkspaceDigest(ctx, digestRecord(userID, "ws_home", "rev1", "")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}
	if records, _ := db.ListWorkspaceDigestsOf(ctx, "ws_home"); len(records) != 0 {
		t.Fatalf("digest kept after the workspace was deleted: %+v", records)
	}
}

func TestDeleteWorkspaceDigestsKeepsOnlyThoseNamed(t *testing.T) {
	db, userID := newDigestStore(t)
	ctx := context.Background()
	if err := db.SaveWorkspaceDigest(ctx, digestRecord(userID, "ws_home", "rev1", "")); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteWorkspaceDigests(ctx, userID, []string{"ws_home"}); err != nil {
		t.Fatal(err)
	}
	if records, _ := db.ListWorkspaceDigests(ctx, userID); len(records) != 1 {
		t.Fatalf("kept digest deleted: %+v", records)
	}
	if err := db.DeleteWorkspaceDigests(ctx, userID, nil); err != nil {
		t.Fatal(err)
	}
	if records, _ := db.ListWorkspaceDigests(ctx, userID); len(records) != 0 {
		t.Fatalf("digest kept: %+v", records)
	}
}
