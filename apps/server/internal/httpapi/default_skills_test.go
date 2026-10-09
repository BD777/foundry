package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A person's default skills reach every workspace on their devices, give way
// to a workspace's own skill of the same name, and never reach someone else's
// workspace.
func TestDefaultSkillsFollowTheWorkspaceOwner(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	add := func(name, dir string) store.PromotedSkill {
		t.Helper()
		archive, _ := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: " + name + "\n---\n"})
		skill, _, err := f.server.store.AddPromotedSkillRevision(ctx,
			store.PromoteSkillInput{DeviceID: "dev_alice", Root: "/skills", DirName: dir}, name, "", archive, 1)
		if err != nil {
			t.Fatal(err)
		}
		return skill
	}
	review := add("review", "review")
	ownReview := add("review", "review-own")
	notes := add("notes", "notes")

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/me/default-skills",
		`{"skillIds":["`+review.ID+`","`+ownReview.ID+`"]}`)), http.StatusBadRequest, "two defaults share a name")
	saved := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/me/default-skills",
		`{"skillIds":["`+review.ID+`","`+notes.ID+`","missing"]}`))
	expectStatus(t, saved, http.StatusOK, "alice sets defaults")
	var mine struct {
		SkillIDs []string `json:"skillIds"`
	}
	_ = json.Unmarshal(saved.Body.Bytes(), &mine)
	if len(mine.SkillIDs) != 2 {
		t.Fatalf("saved defaults %v, want review and notes", mine.SkillIDs)
	}

	if err := f.server.store.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{WorkspaceID: "ws_alice", SkillIDs: []string{ownReview.ID}}); err != nil {
		t.Fatal(err)
	}
	refs, err := sessionSkillRefs(ctx, f.server.store, "ws_alice", "codex")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, ref := range refs {
		got[ref.Name] = ref.SkillID
	}
	if len(refs) != 2 || got["review"] != ownReview.ID || got["notes"] != notes.ID {
		t.Fatalf("alice's workspace gets %+v, want her own review plus default notes", refs)
	}

	usage := func(session string) map[string][]string {
		t.Helper()
		listed := doAuthCall(t, f.handler, f.as(session, http.MethodGet, "/api/skills/catalog", ""))
		expectStatus(t, listed, http.StatusOK, "list the catalog")
		var skills []store.PromotedSkill
		_ = json.Unmarshal(listed.Body.Bytes(), &skills)
		result := map[string][]string{}
		for _, skill := range skills {
			result[skill.ID] = skill.UsedByWorkspaces
		}
		return result
	}
	if used := usage(f.alice)[ownReview.ID]; len(used) != 1 || used[0] == "ws_alice" {
		t.Fatalf("alice sees her review used by %v, want her workspace's name", used)
	}
	if used := usage(f.bob)[ownReview.ID]; len(used) != 0 {
		t.Fatalf("bob sees alice's workspaces using a skill: %v", used)
	}

	bobRefs, err := sessionSkillRefs(ctx, f.server.store, "ws_bob", "codex")
	if err != nil {
		t.Fatal(err)
	}
	if len(bobRefs) != 0 {
		t.Fatalf("bob's workspace gets alice's defaults: %+v", bobRefs)
	}
	var bobs struct {
		SkillIDs []string `json:"skillIds"`
	}
	listed := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/me/default-skills", ""))
	expectStatus(t, listed, http.StatusOK, "bob lists his defaults")
	_ = json.Unmarshal(listed.Body.Bytes(), &bobs)
	if len(bobs.SkillIDs) != 0 {
		t.Fatalf("bob sees alice's defaults: %v", bobs.SkillIDs)
	}
	var data store.FoundryDataProjection
	loaded := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/foundry-data?workspaceId=ws_alice", ""))
	expectStatus(t, loaded, http.StatusOK, "alice loads her workspace")
	_ = json.Unmarshal(loaded.Body.Bytes(), &data)
	if len(data.DefaultSkillIDs) != 1 || data.DefaultSkillIDs[0] != notes.ID {
		t.Fatalf("alice's workspace data names defaults %v, want notes (her own review replaces the default)", data.DefaultSkillIDs)
	}

	// Turning a default off in one workspace leaves it out of that
	// workspace only; turning it back on restores it.
	turnOff := func(off string) {
		t.Helper()
		body := `{"skillIds":["` + ownReview.ID + `"],"offSkillIds":[` + off + `]}`
		expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skills", body)), http.StatusOK, "alice sets her workspace's skills")
	}
	turnOff(`"` + notes.ID + `"`)
	refs, defaultIDs, err := workspaceSkillRefs(ctx, f.server.store, "ws_alice")
	if err != nil || len(refs) != 1 || refs[0].SkillID != ownReview.ID || len(defaultIDs) != 0 {
		t.Fatalf("with notes off alice's workspace gets %+v (defaults %v, err %v), want only her review", refs, defaultIDs, err)
	}
	loaded = doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/foundry-data?workspaceId=ws_alice", ""))
	_ = json.Unmarshal(loaded.Body.Bytes(), &data)
	if len(data.OffSkillIDs) != 1 || data.OffSkillIDs[0] != notes.ID || !slices.Contains(data.InheritedSkillIDs, notes.ID) {
		t.Fatalf("workspace data off %v inherited %v, want notes in both", data.OffSkillIDs, data.InheritedSkillIDs)
	}
	turnOff(``)
	if refs, _, _ := workspaceSkillRefs(ctx, f.server.store, "ws_alice"); len(refs) != 2 {
		t.Fatalf("notes turned back on, alice's workspace gets %+v", refs)
	}
}
