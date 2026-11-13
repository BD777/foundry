package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A connector whose npm tool ships Skills (tool.skills) brings the Skill
// library bundle that follows that package: the Connectors pages name it,
// and a session that receives the connector gets its Skills, marked with
// the bundle. Without a followed bundle the pages say which package to follow.
func TestConnectorToolSkillsComeFromTheFollowedPackageBundle(t *testing.T) {
	f := newIsolationFixture(t)
	registry := &npmRegistryFake{name: "corpcli", tarballs: map[string][]byte{}}
	registry.server = httptest.NewServer(registry)
	defer registry.server.Close()
	registry.publish("1.2.0", npmPackageTarball(t, map[string]string{
		"package.json":                `{"name":"corpcli","bin":{"corpcli":"./bin/corpcli.js"}}`,
		"skills/corp-search/SKILL.md": "---\nname: corp-search\ndescription: Search\n---\nbody\n",
		"skills/corp-deploy/SKILL.md": "---\nname: corp-deploy\ndescription: Deploy\n---\nbody\n",
	}))
	f.server.skillRepos = skillrepo.Sources{Git: skillrepo.Git{}, NPM: skillrepo.NPM{Registry: registry.server.URL}}
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/skill-repositories",
		`{"url":"npm:corpcli","subpath":"skills","mode":"bundle","name":"corpcli"}`))
	expectStatus(t, recorder, http.StatusCreated, "follow the package")
	var added store.SkillRepositoryView
	_ = json.Unmarshal(recorder.Body.Bytes(), &added)
	repoID := added.Repository.ID

	declaring := store.ConnectorDescriptor{Kind: "corpcli", Tool: store.ConnectorTool{
		Command: "corpcli", Source: "npm", Package: "corpcli", Registry: "device",
		Skills: &store.ConnectorToolSkills{Path: "skills"},
	}}
	other := declaring
	other.Kind, other.Tool.Package = "othercli", "othercli"
	plain := declaring
	plain.Kind, plain.Tool.Skills = "plaincli", nil

	bundles, err := f.server.connectorSkillBundles(context.Background(), f.aliceID, "", []store.ConnectorDescriptor{declaring, other, plain})
	if err != nil {
		t.Fatal(err)
	}
	if len(bundles) != 2 {
		t.Fatalf("bundles %+v", bundles)
	}
	if got := bundles[0]; got.Kind != "corpcli" || got.Source != "tool" || got.RepositoryID != repoID ||
		got.Name != "corpcli" || got.Version != "1.2.0" || got.SkillCount != 2 || got.OnCount != 2 {
		t.Fatalf("linked bundle %+v", got)
	}
	if got := bundles[1]; got.Kind != "othercli" || got.RepositoryID != "" || got.Package != "othercli" {
		t.Fatalf("unfollowed package %+v", got)
	}

	repos, err := f.server.store.ListSkillRepositories(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if repo, ok := toolSkillRepository(repos, declaring); !ok || repo.ID != repoID {
		t.Fatalf("tool skill repository %+v %v", repo, ok)
	}
	refs, _, err := sessionPackageSkills(context.Background(), f.server.store, f.aliceID, "dev_alice",
		map[string]bool{"corpcli": true}, []connectorSkillSource{{RepositoryID: repoID}})
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || refs[0].Name != "corp-deploy" || refs[1].Name != "corp-search" || refs[1].Bundle == nil || refs[1].Bundle.ID != repoID {
		t.Fatalf("session refs %+v", refs)
	}
	none, _, err := sessionPackageSkills(context.Background(), f.server.store, f.aliceID, "dev_alice", nil, []connectorSkillSource{{RepositoryID: repoID}})
	if err != nil || len(none) != 0 {
		t.Fatalf("a session without connectors got %+v %v", none, err)
	}

	// tool.skills.default turns on only the named Skills; a workspace turns on
	// another by selecting it, and the card counts both.
	declaring.Tool.Skills.Default = []string{"corp-search", "not-in-bundle"}
	refs, _, err = sessionPackageSkills(context.Background(), f.server.store, f.aliceID, "dev_alice",
		map[string]bool{"corpcli": true}, []connectorSkillSource{{RepositoryID: repoID, Default: declaring.Tool.Skills.Default}})
	if err != nil || len(refs) != 1 || refs[0].Name != "corp-search" {
		t.Fatalf("default refs %+v %v", refs, err)
	}
	bundles, err = f.server.connectorSkillBundles(context.Background(), f.aliceID, "", []store.ConnectorDescriptor{declaring})
	if err != nil || len(bundles) != 1 || bundles[0].OnCount != 1 || bundles[0].SkillCount != 2 {
		t.Fatalf("default count %+v %v", bundles, err)
	}
	var deploy string
	for _, member := range added.Repository.Skills {
		if member.Name == "corp-deploy" {
			deploy = member.SkillID
		}
	}
	if deploy == "" {
		t.Fatalf("bundle skills %+v", added.Repository.Skills)
	}
	workspaceID := "ws_alice"
	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/workspaces/"+workspaceID+"/skills", `{"skillIds":["`+deploy+`"]}`))
	expectStatus(t, recorder, http.StatusOK, "select a bundle Skill in the workspace")
	bundles, err = f.server.connectorSkillBundles(context.Background(), f.aliceID, workspaceID, []store.ConnectorDescriptor{declaring})
	if err != nil || len(bundles) != 1 || bundles[0].OnCount != 2 {
		t.Fatalf("workspace count %+v %v", bundles, err)
	}

	// A Skill of the same name in the device's own folders wins over the
	// bundle's copy, for the agent that reads that folder.
	if _, err := f.server.store.ReplaceDeviceSkills(context.Background(), store.ReplaceDeviceSkillsInput{DeviceID: "dev_alice", Skills: []store.DeviceSkill{
		{DeviceID: "dev_alice", Root: "~/.claude/skills", DirName: "corp-search", Name: "corp-search", Description: "mine"},
		{DeviceID: "dev_alice", Root: "/elsewhere/project/.claude/skills", DirName: "corp-deploy", Name: "corp-deploy"},
	}}); err != nil {
		t.Fatal(err)
	}
	own, err := deviceOwnSkillNames(context.Background(), f.server.store, "dev_alice", "/work/alice", "claude")
	if err != nil || !own["corp-search"] || own["corp-deploy"] {
		t.Fatalf("claude's own skills %v %v", own, err)
	}
	if own, _ := deviceOwnSkillNames(context.Background(), f.server.store, "dev_alice", "/work/alice", "codex"); own["corp-search"] {
		t.Fatalf("codex does not read ~/.claude/skills: %v", own)
	}
	merged, _, err := workspacePackageSkills(context.Background(), f.server.store, f.aliceID, workspaceID, "dev_alice",
		map[string]bool{"corpcli": true}, []connectorSkillSource{{RepositoryID: repoID}}, own, nil)
	if err != nil || len(merged) != 1 || merged[0].Name != "corp-deploy" {
		t.Fatalf("merged without the device's own copy %+v %v", merged, err)
	}
}
