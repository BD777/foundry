package sqlitestore

import (
	"context"
	"errors"
	"strings"
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

// Digests kept before redaction are redacted in place at start; a summary
// that held a secret is redacted and written again, one that did not
// stays.
func TestRedactWorkspaceDigestsCleansStoredDigests(t *testing.T) {
	db, userID := newDigestStore(t)
	ctx := context.Background()
	pasted := "配一下这个机器到本地 ~/.ssh/config，准备用来跑 renderkit IP：203.0.113.62 user：ec2-user"
	record := digestRecord(userID, "ws_home", "rev1", "")
	record.Digest.Purpose = "GPU 机器 203.0.113.62"
	record.Digest.RecentSessions = []store.WorkspaceDigestSession{{ID: "s1", Title: pasted}}
	record.Digest.OpenIssues = []store.WorkspaceDigestIssue{{ID: "iss_1", Title: "token sk-proj-AbCdEf1234567890GhIjKlMnOp leaked"}}
	record.History = []string{pasted, "帮我改简历"}
	record.Files = []string{"ec2-user@203.0.113.62.pem", "render/"}
	if err := db.SaveWorkspaceDigest(ctx, record); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveWorkspaceDigestIntro(ctx, "ws_home", "files", "Deploy with ssh ec2-user@203.0.113.62."); err != nil {
		t.Fatal(err)
	}
	summarize := func(sessionID string, summary store.WorkspaceDigestSummary) {
		t.Helper()
		if claimed, err := db.ClaimWorkspaceDigestSummary(ctx, userID, "ws_home", sessionID, "rev1"); err != nil || !claimed {
			t.Fatalf("claim = %v, %v", claimed, err)
		}
		if err := db.FinishWorkspaceDigestSummary(ctx, userID, "ws_home", sessionID, &summary, "rev1", "2026-10-15T01:00:00Z", "2026-10-15T07:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}
	stored := func() store.WorkspaceDigestRecord {
		t.Helper()
		records, err := db.ListWorkspaceDigests(ctx, userID)
		if err != nil || len(records) != 1 {
			t.Fatalf("records = %+v, %v", records, err)
		}
		return records[0]
	}
	leaks := func(record store.WorkspaceDigestRecord) {
		t.Helper()
		digest := record.Digest
		text := strings.Join(append(append([]string{digest.Purpose, digest.RecentSessions[0].Title, digest.OpenIssues[0].Title, digest.Intro, digest.L0, digest.Summary},
			digest.RouteWhen...), append(record.History, record.Files...)...), "\n")
		for _, secret := range []string{"203.0.113.62", "ec2-user", "sk-proj-AbCdEf"} {
			if strings.Contains(text, secret) {
				t.Errorf("stored digest holds %q: %q", secret, text)
			}
		}
		for _, kept := range []string{"准备用来跑 renderkit", "帮我改简历", "render/"} {
			if !strings.Contains(text, kept) {
				t.Errorf("stored digest lost %q: %q", kept, text)
			}
		}
	}

	summarize("sess_1", store.WorkspaceDigestSummary{L0: "renderkit 渲染机", Summary: "跑 renderkit。", RouteWhen: []string{"renderkit"}})
	if err := db.redactWorkspaceDigests(ctx); err != nil {
		t.Fatal(err)
	}
	clean := stored()
	leaks(clean)
	if clean.Digest.Dirty || clean.SummaryDueAt != "" || clean.Digest.L0 != "renderkit 渲染机" {
		t.Fatalf("a summary without secrets was redone: %+v", clean)
	}

	summarize("sess_2", store.WorkspaceDigestSummary{L0: "renderkit on 203.0.113.62", Summary: "ssh ec2-user@203.0.113.62", RouteWhen: []string{"机器 203.0.113.62"}})
	if err := db.redactWorkspaceDigests(ctx); err != nil {
		t.Fatal(err)
	}
	redone := stored()
	leaks(redone)
	if !redone.Digest.Dirty || redone.SummaryDueAt == "" || redone.Digest.L0 != "renderkit on ‹ip›" {
		t.Fatalf("a summary with secrets is not redacted and due again: %+v", redone)
	}
	if err := db.redactWorkspaceDigests(ctx); err != nil {
		t.Fatal(err)
	}
	if again := stored(); again.SummaryDueAt != redone.SummaryDueAt || again.Digest.L0 != redone.Digest.L0 {
		t.Fatalf("redacting twice changed the digest: %+v", again)
	}
}
