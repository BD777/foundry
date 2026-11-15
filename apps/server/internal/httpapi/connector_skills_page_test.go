package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A connector the workspace's sessions receive brings its Skills on by
// default, and the Skills page says so: they are among inheritedSkillIds,
// connectorSkills names the connector, and turning one off sticks for the
// page and for sessions. When the connector is no longer granted they go.
func TestConnectorSkillsAreOnInTheWorkspaceSkillsPage(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	registry := &npmRegistryFake{name: "corpcli", tarballs: map[string][]byte{}}
	registry.server = httptest.NewServer(registry)
	defer registry.server.Close()
	registry.publish("1.0.0", npmPackageTarball(t, map[string]string{
		"package.json":                `{"name":"corpcli","bin":{"corpcli":"./bin/corpcli.js"}}`,
		"skills/corp-search/SKILL.md": "---\nname: corp-search\ndescription: Search\n---\nbody\n",
		"skills/corp-deploy/SKILL.md": "---\nname: corp-deploy\ndescription: Deploy\n---\nbody\n",
		"skills/corp-extra/SKILL.md":  "---\nname: corp-extra\ndescription: Extra\n---\nbody\n",
	}))
	f.server.skillRepos = skillrepo.Sources{Git: skillrepo.Git{}, NPM: skillrepo.NPM{Registry: registry.server.URL}}
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/skill-repositories",
		`{"url":"npm:corpcli","subpath":"skills","mode":"bundle","name":"corpcli"}`))
	expectStatus(t, recorder, http.StatusCreated, "follow the package")
	var added store.SkillRepositoryView
	_ = json.Unmarshal(recorder.Body.Bytes(), &added)
	ids := map[string]string{}
	for _, member := range added.Repository.Skills {
		ids[member.Name] = member.SkillID
	}

	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	descriptor := corpcliExtension()
	descriptor["tool"] = map[string]any{
		"command": "corpcli", "source": "npm", "package": "corpcli", "registry": "device",
		"skills": map[string]any{"path": "skills", "default": []any{"corp-search", "corp-deploy"}},
	}
	worker := &fakeConnectorWorker{t: t, signedIn: true, reportedConnectors: []any{descriptor}}
	worker.connect(httpServer.URL, f.aliceDevice)
	defer worker.disconnect()
	waitFor(t, "the device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })
	if _, err := f.server.connectors.Devices.Record(ctx, "dev_alice", store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorReady, SignedIn: true, Identity: "someone"}); err != nil {
		t.Fatal(err)
	}

	type page struct {
		InheritedSkillIDs []string                `json:"inheritedSkillIds"`
		OffSkillIDs       []string                `json:"offSkillIds"`
		WorkspaceSkills   []workspaceSkillSummary `json:"workspaceSkills"`
		ConnectorSkills   []connectorSkillGroup   `json:"connectorSkills"`
	}
	read := func() page {
		t.Helper()
		var data page
		recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet,
			"/api/foundry-data?workspaceId=ws_alice&fields=inheritedSkillIds,offSkillIds,workspaceSkills,connectorSkills", ""))
		expectStatus(t, recorder, http.StatusOK, "read the Skills page")
		_ = json.Unmarshal(recorder.Body.Bytes(), &data)
		return data
	}
	listed := func(data page, name string) bool {
		for _, skill := range data.WorkspaceSkills {
			if skill.Name == name {
				return true
			}
		}
		return false
	}

	data := read()
	want := []string{ids["corp-deploy"], ids["corp-search"]}
	slices.Sort(want)
	if len(data.ConnectorSkills) != 1 || data.ConnectorSkills[0].Kind != "corpcli" || data.ConnectorSkills[0].Label != "corpcli" ||
		!slices.Equal(data.ConnectorSkills[0].SkillIDs, want) || !slices.Equal(data.ConnectorSkills[0].BundleIDs, []string{added.Repository.ID}) {
		t.Fatalf("connector skills %+v", data.ConnectorSkills)
	}
	if !slices.Contains(data.InheritedSkillIDs, ids["corp-search"]) || !slices.Contains(data.InheritedSkillIDs, ids["corp-deploy"]) ||
		slices.Contains(data.InheritedSkillIDs, ids["corp-extra"]) || len(data.OffSkillIDs) != 0 {
		t.Fatalf("inherited %v off %v", data.InheritedSkillIDs, data.OffSkillIDs)
	}
	if !listed(data, "corp-search") || !listed(data, "corp-deploy") || listed(data, "corp-extra") {
		t.Fatalf("workspace skills %+v", data.WorkspaceSkills)
	}

	// Turning one off sticks: the page lists it off, sessions do not get it.
	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/workspaces/ws_alice/skills",
		`{"skillIds":[],"offSkillIds":["`+ids["corp-search"]+`"]}`))
	expectStatus(t, recorder, http.StatusOK, "turn a connector skill off")
	data = read()
	if !slices.Equal(data.OffSkillIDs, []string{ids["corp-search"]}) || !slices.Contains(data.InheritedSkillIDs, ids["corp-search"]) ||
		listed(data, "corp-search") || !listed(data, "corp-deploy") {
		t.Fatalf("after turning off: %+v", data)
	}
	kinds := map[string]bool{"corpcli": true}
	tools, err := connectorToolBundles(ctx, f.server.store, f.server.connectors.Devices, "dev_alice", kinds)
	if err != nil {
		t.Fatal(err)
	}
	refs, _, err := workspacePackageSkills(ctx, f.server.store, f.aliceID, "ws_alice", "dev_alice", kinds, tools, nil, nil)
	if err != nil || len(refs) != 1 || refs[0].Name != "corp-deploy" {
		t.Fatalf("session skills after turning off %+v %v", refs, err)
	}

	// Without the connector's login the workspace no longer receives it.
	if _, err := f.server.connectors.Devices.Record(ctx, "dev_alice", store.DeviceConnectorState{Kind: "corpcli", Status: store.DeviceConnectorSignedOut}); err != nil {
		t.Fatal(err)
	}
	workspace, err := f.server.store.GetWorkspace(ctx, "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	gone, err := f.server.workspaceConnectorSkillView(ctx, store.WorkspaceProjection{ID: workspace.ID, DeviceID: "dev_alice", LocalPath: workspace.LocalPath}, f.aliceID, nil)
	if err != nil || len(gone.Connectors) != 0 || len(gone.Inherited) != 0 || len(gone.Refs) != 0 {
		t.Fatalf("after the connector went: %+v %v", gone, err)
	}
}
