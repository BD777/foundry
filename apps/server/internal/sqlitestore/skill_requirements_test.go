package sqlitestore

import (
	"archive/zip"
	"bytes"
	"context"
	"reflect"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A revision records the programs it runs, revisions stored before that are
// filled in at startup, and a device's report replaces its previous one.
func TestSkillRequirementsAndDeviceTools(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	db := newTestStoreAtPath(t, path)
	ctx := context.Background()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for name, body := range map[string]string{
		"SKILL.md":       "---\nname: media\nmetadata:\n  requires: ffmpeg\n---\n",
		"scripts/cut.py": "print(1)",
	} {
		w, _ := z.Create(name)
		w.Write([]byte(body))
	}
	z.Close()
	skill, _, err := db.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: "dev", Root: "/r", DirName: "media"}, "media", "", buf.Bytes(), 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ffmpeg", "python3"}
	if !reflect.DeepEqual(skill.Requires, want) {
		t.Fatalf("requires %v, want %v", skill.Requires, want)
	}
	if _, err := db.conn().ExecContext(ctx, `UPDATE promoted_skill_revisions SET requires_json = NULL`); err != nil {
		t.Fatal(err)
	}
	if err := db.backfillSkillRequirements(ctx); err != nil {
		t.Fatal(err)
	}
	if loaded, _ := db.GetPromotedSkill(ctx, skill.ID); !reflect.DeepEqual(loaded.Requires, want) {
		t.Fatalf("backfilled requires %v", loaded.Requires)
	}

	if err := db.ReplaceDeviceTools(ctx, "dev", map[string]bool{"ffmpeg": false, "python3": true}, nil); err != nil {
		t.Fatal(err)
	}
	if err := db.ReplaceDeviceTools(ctx, "dev", map[string]bool{"ffmpeg": true}, map[string]string{"feishu-cli": "v1.41.0"}); err != nil {
		t.Fatal(err)
	}
	tools, err := db.ListDeviceTools(ctx, "dev")
	if err != nil || len(tools) != 2 || tools[0].Tool != "feishu-cli" || tools[0].Version != "v1.41.0" || tools[1].Tool != "ffmpeg" || !tools[1].Available {
		t.Fatalf("tools %+v, %v", tools, err)
	}
}
