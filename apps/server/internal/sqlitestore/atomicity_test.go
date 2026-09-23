package sqlitestore

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func registrationInput(t *testing.T, workspaceID string, marker string) store.DaemonRegistration {
	t.Helper()
	deviceID := "dev_" + workspaceID
	return store.DaemonRegistration{
		Device: store.DeviceProjection{
			ID:            deviceID,
			Label:         "Atomicity Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: store.WorkspaceProjection{
			ID:        workspaceID,
			Name:      "Atomicity Workspace",
			LocalPath: t.TempDir(),
		},
		Agents: []store.AgentProjection{{
			ID:           "agent_" + marker,
			WorkspaceID:  workspaceID,
			DeviceID:     deviceID,
			Provider:     "codex",
			Status:       "healthy",
			AuthMode:     "local_config",
			SecretStored: "local",
		}},
		WorkspaceFiles: []store.WorkspaceFileEntry{{
			ID:          "file_" + marker,
			WorkspaceID: workspaceID,
			Path:        marker + ".md",
			Kind:        "doc",
		}},
		Assets: []store.AssetProjection{{
			ID:          "asset_" + marker,
			WorkspaceID: workspaceID,
			Name:        marker,
			Kind:        "worktree",
			Status:      "available",
		}},
		Skills: []store.SkillPackRef{{
			ID:          "skill_" + marker,
			WorkspaceID: workspaceID,
			Name:        marker,
			Version:     "1.0",
		}},
	}
}

func TestRegisterDaemonRollsBackFailedReplacement(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	const workspaceID = "ws_rollback"

	if err := db.RegisterDaemon(ctx, registrationInput(t, workspaceID, "before")); err != nil {
		t.Fatalf("register daemon: %v", err)
	}

	// Assets, skills, and files are replaced before agents. A database trigger
	// fails the final replacement without adding a test seam to production code;
	// without the surrounding transaction the earlier projections disappear.
	if _, err := db.conn().ExecContext(ctx, `CREATE TRIGGER fail_after_agent
		BEFORE INSERT ON agents WHEN NEW.id = 'agent_after'
		BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}
	err := db.RegisterDaemon(ctx, registrationInput(t, workspaceID, "after"))
	if err == nil || !strings.Contains(err.Error(), "injected replacement failure") {
		t.Fatalf("expected injected failure, got %v", err)
	}

	assets, err := db.ListAssets(ctx, workspaceID)
	if err != nil {
		t.Fatalf("list assets: %v", err)
	}
	if len(assets) != 1 || assets[0].ID != "asset_before" {
		t.Fatalf("expected prior asset projection intact, got %#v", assets)
	}
	skills, err := db.ListSkills(ctx, workspaceID)
	if err != nil {
		t.Fatalf("list skills: %v", err)
	}
	if len(skills) != 1 || skills[0].ID != "skill_before" {
		t.Fatalf("expected prior skill projection intact, got %#v", skills)
	}
	files, err := db.ListWorkspaceFiles(ctx, workspaceID)
	if err != nil {
		t.Fatalf("list workspace files: %v", err)
	}
	if len(files) != 1 || files[0].ID != "file_before" {
		t.Fatalf("expected prior file projection intact, got %#v", files)
	}
	agents, err := db.ListAgents(ctx, workspaceID, "")
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if len(agents) != 1 || agents[0].ID != "agent_before" {
		t.Fatalf("expected prior agent projection intact, got %#v", agents)
	}
}

func TestClaimNextIssueDoesNotHandOneIssueToTwoDevices(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	const workspaceID = "ws_claim"

	if err := db.RegisterDaemon(ctx, registrationInput(t, workspaceID, "claim")); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	const claimants = 8
	for i := 0; i < claimants; i++ {
		issue, err := db.CreateIssue(ctx, store.CreateIssueInput{
			WorkspaceID: workspaceID,
			Title:       fmt.Sprintf("claimable %d", i),
		})
		if err != nil {
			t.Fatalf("create issue: %v", err)
		}
		testfixture.ConfirmContract(t, db, issue.ID)
	}

	var wg sync.WaitGroup
	claims := make([]string, claimants)
	failures := make([]error, claimants)
	start := make(chan struct{})
	for i := 0; i < claimants; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			issue, err := db.ClaimNextIssue(ctx, fmt.Sprintf("dev_%d", index), workspaceID)
			if err != nil {
				failures[index] = err
				return
			}
			claims[index] = issue.ID
		}(i)
	}
	close(start)
	wg.Wait()

	seen := map[string]int{}
	for i, id := range claims {
		if failures[i] != nil {
			t.Fatalf("claim %d failed: %v", i, failures[i])
		}
		if id == "" {
			t.Fatalf("claim %d returned an empty issue id", i)
		}
		seen[id]++
	}
	for id, count := range seen {
		if count > 1 {
			t.Fatalf("issue %s was claimed %d times", id, count)
		}
	}

	issues, err := db.ListIssues(ctx, workspaceID)
	if err != nil {
		t.Fatalf("list issues: %v", err)
	}
	for _, issue := range issues {
		if issue.Status != "in_progress" {
			t.Fatalf("expected every issue claimed once, %s has status %q", issue.ID, issue.Status)
		}
	}
}

func TestCreateIssueAfterDeleteDoesNotOverwriteExistingIssue(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	const workspaceID = "ws_sequence"

	first, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: workspaceID, Title: "first"})
	if err != nil {
		t.Fatalf("create first issue: %v", err)
	}
	second, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: workspaceID, Title: "second"})
	if err != nil {
		t.Fatalf("create second issue: %v", err)
	}
	if first.ID == second.ID {
		t.Fatalf("expected distinct issue ids, got %s twice", first.ID)
	}

	if _, err := db.conn().ExecContext(ctx, `DELETE FROM issues WHERE id = ?`, first.ID); err != nil {
		t.Fatalf("delete first issue: %v", err)
	}

	third, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: workspaceID, Title: "third"})
	if err != nil {
		t.Fatalf("create third issue: %v", err)
	}
	if third.ID == second.ID || third.ShortID == second.ShortID {
		t.Fatalf("third issue reused the live issue identity %s/%s", second.ID, second.ShortID)
	}

	survivor, err := db.GetIssue(ctx, second.ID)
	if err != nil {
		t.Fatalf("get surviving issue: %v", err)
	}
	if survivor.Title != "second" {
		t.Fatalf("existing issue was overwritten, title = %q", survivor.Title)
	}
}
