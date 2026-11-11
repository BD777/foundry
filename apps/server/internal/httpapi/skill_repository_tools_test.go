package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestBundleFollowsRepositoryToolsFromItsOwnCommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	f := newIsolationFixture(t)
	f.server.skillRepos = serverMustNotRead{t: t}
	httpServer := httptest.NewServer(f.handler)
	defer httpServer.Close()
	repo := localRepo{t: t, dir: t.TempDir()}
	repo.git("init", "--quiet", "--initial-branch=main")
	repo.commit(map[string]string{
		"plugins/open-lark/skills/olk/SKILL.md": "---\nname: olk\ndescription: OpenLark\n---\nv1\n",
	})
	worker := &fakeFetchWorker{t: t, serverURL: httpServer.URL, credential: f.aliceDevice, repo: repo}
	worker.connect()
	defer worker.disconnect()
	waitFor(t, "the repository device to connect", func() bool { return f.server.hub.HasConnection("dev_alice") })

	tools := `[{"source":"repository","command":"olk","path":"plugins/open-lark","bins":{"olk":"bin/olk","olk-ctx":"bin/olk-ctx"}}]`
	var added store.SkillRepositoryView
	recorder := doAuthCall(t, f.handler, f.as(
		f.alice, http.MethodPost, "/api/skill-repositories",
		`{"url":"https://github.com/nwverse/open-lark","ref":"main","subpath":"plugins/open-lark/skills","mode":"bundle","name":"OpenLark","deviceId":"dev_alice","tools":`+tools+`}`,
	))
	expectStatus(t, recorder, http.StatusCreated, "follow package bundle")
	_ = json.Unmarshal(recorder.Body.Bytes(), &added)
	if len(added.Repository.Tools) != 1 {
		t.Fatalf("bundle tools: %+v", added.Repository.Tools)
	}
	tool := added.Repository.Tools[0]
	firstCommit := repo.git("rev-parse", "HEAD")
	if tool.Source != "repository" || tool.Version != firstCommit ||
		tool.Repository != "https://github.com/nwverse/open-lark" ||
		tool.Path != "plugins/open-lark" || tool.Bins["olk-ctx"] != "bin/olk-ctx" {
		t.Fatalf("repository tool: %+v", tool)
	}
	firstSeq := added.Repository.Versions[0].Seq

	repo.commit(map[string]string{
		"plugins/open-lark/skills/olk/SKILL.md": "---\nname: olk\ndescription: OpenLark\n---\nv2\n",
	})
	secondCommit := repo.git("rev-parse", "HEAD")
	recorder = doAuthCall(t, f.handler, f.as(
		f.alice, http.MethodPost, "/api/skill-repositories/"+added.Repository.ID+"/check", "",
	))
	expectStatus(t, recorder, http.StatusOK, "check package bundle")
	var checked store.SkillRepository
	_ = json.Unmarshal(recorder.Body.Bytes(), &checked)
	if checked.Version != "main@"+secondCommit[:7] || len(checked.Tools) != 1 || checked.Tools[0].Version != secondCommit {
		t.Fatalf("updated bundle %q tools %+v, want %s", checked.Version, checked.Tools, secondCommit)
	}
	recorder = doAuthCall(t, f.handler, f.as(
		f.alice, http.MethodPost, "/api/skill-repositories/"+added.Repository.ID+"/rollback",
		`{"seq":`+strconv.Itoa(firstSeq)+`}`,
	))
	expectStatus(t, recorder, http.StatusOK, "roll package bundle back")
	var rolled store.SkillRepository
	_ = json.Unmarshal(recorder.Body.Bytes(), &rolled)
	if len(rolled.Tools) != 1 || rolled.Tools[0].Version != firstCommit || !rolled.Paused {
		t.Fatalf("rolled back bundle tools: %+v", rolled.Tools)
	}
}
