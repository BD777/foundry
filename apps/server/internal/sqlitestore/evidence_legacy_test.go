package sqlitestore

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestLegacyContractImportPreservesHistoryWithoutInventingEvidence(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	issue := store.Issue{ID: "legacy", ShortID: "ISS-legacy", WorkspaceID: "ws", Status: "review",
		SourceInput: "Fix API validation", AcceptanceCriteria: []string{
			"One primary acceptance artifact is produced.", "Worker events are visible on the issue.",
			"Accept and request-changes remain explicit review actions.", "Invalid inputs return 400",
		}, Checks: []string{"Tests passed"}, Artifact: &store.AcceptanceArtifact{ID: "old_report", PrimaryURI: "acceptance.md"}}
	if err := db.saveIssue(ctx, issue, time.Now().UTC(), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	c, err := db.ImportLegacyContract(ctx, issue.ID, owner, "import")
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != "draft" || c.Origin != "legacy_import" || c.Confirmation != nil || len(c.Criteria) != 0 ||
		!strings.Contains(c.Goal.Text, "Invalid inputs return 400") || strings.Contains(c.Goal.Text, "primary acceptance artifact") {
		t.Fatalf("invalid legacy promotion: %+v", c)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, c.Revision, c.ContentDigest, owner, "confirm"); err == nil {
		t.Fatal("import invented enough criteria to confirm")
	}
	replayed, err := db.ImportLegacyContract(ctx, issue.ID, owner, "import")
	if err != nil || replayed.ID != c.ID {
		t.Fatalf("import replay: %v", err)
	}
	current, err := db.GetIssue(ctx, issue.ID)
	if err != nil || len(current.AcceptanceCriteria) != 4 || current.Checks[0] != "Tests passed" || current.Artifact.PrimaryURI != "acceptance.md" {
		t.Fatalf("historical fields changed: %+v %v", current, err)
	}
	for _, kind := range []string{"evidence", "verification", "decision"} {
		records, err := db.ListEvidenceRecords(ctx, issue.ID, kind)
		if err != nil || len(records) != 0 {
			t.Fatalf("import promoted %s: %v", kind, err)
		}
	}
	for _, status := range []string{"accepted", "abandoned"} {
		issue.ID = status
		issue.ShortID = "ISS-" + status
		issue.Status = status
		if err := db.saveIssue(ctx, issue, time.Now().UTC(), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ImportLegacyContract(ctx, issue.ID, owner, status); err == nil {
			t.Fatalf("rewrote terminal %s", status)
		}
	}
}
