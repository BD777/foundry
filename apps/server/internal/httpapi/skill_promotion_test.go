package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPromotionClosure(t *testing.T) {
	dep := func(name string) store.SkillDependency {
		return store.SkillDependency{SkillName: name, Strength: store.SkillDependencyRequired, Status: "resolved", TargetRoot: "/skills", TargetDirName: name}
	}
	a := store.DeviceSkill{DependenciesAnalyzed: true, SourceDigest: "snapshot", Name: "a", Root: "/skills", DirName: "a", Dependencies: []store.SkillDependency{dep("b")}}
	b := store.DeviceSkill{DependenciesAnalyzed: true, SourceDigest: "snapshot", Name: "b", Root: "/skills", DirName: "b", Dependencies: []store.SkillDependency{dep("a")}}
	input := store.PromoteSkillInput{Root: a.Root, DirName: a.DirName}
	plan := buildSkillPromotionPlan(input, []store.DeviceSkill{a, b})
	if len(plan.Skills) != 2 || len(plan.Problems) != 0 {
		t.Fatalf("cycle closure: %+v", plan)
	}
	missing := buildSkillPromotionPlan(input, []store.DeviceSkill{a})
	if len(missing.Problems) == 0 {
		t.Fatal("missing dependency accepted")
	}
	b.MtimeLabel = "changed"
	changed := buildSkillPromotionPlan(input, []store.DeviceSkill{a, b})
	if changed.Digest == plan.Digest {
		t.Fatal("stale plan not detected")
	}
	a.Dependencies[0].Strength = store.SkillDependencyRelated
	optional := buildSkillPromotionPlan(input, []store.DeviceSkill{a, b})
	if len(optional.Skills) != 1 || len(optional.Related) != 1 {
		t.Fatal("related reference auto included")
	}
	input.IncludeRelated = []string{"b"}
	included := buildSkillPromotionPlan(input, []store.DeviceSkill{a, b})
	if len(included.Skills) != 2 {
		t.Fatal("optional choice ignored")
	}
	a.DependencyAnalysisError = "unreadable"
	if len(buildSkillPromotionPlan(input, []store.DeviceSkill{a, b}).Problems) == 0 {
		t.Fatal("incomplete analysis accepted")
	}
}

func TestPromotionHTTPPublishesRequiredClosureAndRejectsStalePlan(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_deps", "label": "Dependency test", "status": "connected"},
		"workspace": map[string]any{"id": "ws_deps", "name": "Dependency test", "localPath": "/tmp/deps", "baseline": "main"},
	})
	readWSTypeForTest(t, conn, "registered")
	archives := map[string][]byte{}
	indices := map[string]skillarchive.Index{}
	for _, name := range []string{"a", "b", "c"} {
		var out bytes.Buffer
		zw := zip.NewWriter(&out)
		f, _ := zw.CreateHeader(&zip.FileHeader{Name: "SKILL.md", Method: zip.Store})
		f.Write([]byte("---\nname: " + name + "\n---\n"))
		f, _ = zw.CreateHeader(&zip.FileHeader{Name: "asset.txt", Method: zip.Store})
		f.Write(bytes.Repeat([]byte("x"), 3<<20))
		zw.Close()
		archives[name] = out.Bytes()
		idx, err := skillarchive.Inspect(out.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		indices[name] = idx
	}
	var stale atomic.Bool
	var scans atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			var request wsEnvelope
			if conn.ReadJSON(&request) != nil {
				return
			}
			var payload any
			var kind string
			switch request.Type {
			case wsScanSkillsType:
				scans.Add(1)
				stamp := "original"
				if stale.Load() {
					stamp = "changed"
				}
				payload = wsSkillsScannedPayload{Skills: []store.DeviceSkill{
					{DependenciesAnalyzed: true, SourceDigest: indices["a"].SourceDigest, Manifest: indices["a"].Files, Name: "a", Root: "~/.claude/skills", DirName: "a", MtimeLabel: stamp, Dependencies: []store.SkillDependency{{SkillName: "b", Strength: store.SkillDependencyRequired, Status: "resolved", TargetRoot: "~/.claude/skills", TargetDirName: "b"}}},
					{DependenciesAnalyzed: true, SourceDigest: indices["b"].SourceDigest, Manifest: indices["b"].Files, Name: "b", Root: "~/.claude/skills", DirName: "b", Dependencies: []store.SkillDependency{{SkillName: "c", Strength: store.SkillDependencyRequired, Status: "resolved", TargetRoot: "~/.claude/skills", TargetDirName: "c"}}},
					{DependenciesAnalyzed: true, SourceDigest: indices["c"].SourceDigest, Manifest: indices["c"].Files, Name: "c", Root: "~/.claude/skills", DirName: "c", Dependencies: []store.SkillDependency{{SkillName: "a", Strength: store.SkillDependencyRequired, Status: "resolved", TargetRoot: "~/.claude/skills", TargetDirName: "a"}}},
				}}
				kind = wsSkillsScannedType
			case wsReadSkillContentType:
				var source wsReadSkillContentPayload
				_ = json.Unmarshal(request.Payload, &source)
				digest := indices[source.DirName].SourceDigest
				if stale.Load() && source.DirName == "c" {
					digest = "file changed without a rescan"
				}
				// Exercise a reply larger than the old 2 MiB WS ceiling.
				payload = wsSkillContentReadPayload{Name: source.DirName, SourceDigest: digest, ContentB64: base64.StdEncoding.EncodeToString(archives[source.DirName]), FileCount: 1}
				kind = wsSkillContentReadType
			default:
				continue
			}
			raw, _ := json.Marshal(payload)
			if conn.WriteJSON(wsEnvelope{ID: request.ID, Type: kind, Payload: raw}) != nil {
				return
			}
		}
	}()
	if _, err := server.hub.ScanDeviceSkills(context.Background(), "dev_deps", []string{"~/.claude/skills"}); err != nil {
		t.Fatal(err)
	}
	if scans.Load() != 1 {
		t.Fatal("expected one explicit graph scan")
	}
	input := store.PromoteSkillInput{DeviceID: "dev_deps", Root: "~/.claude/skills", DirName: "a"}
	raw, _ := json.Marshal(input)
	response := requestForTest(t, server, http.MethodPost, "/api/skills/promote-plan", string(raw), http.StatusOK)
	var plan store.SkillPromotionPlan
	if err := json.Unmarshal(response.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.Skills) != 3 {
		t.Fatalf("plan: %s", response.Body.String())
	}
	input.PlanDigest = plan.Digest
	raw, _ = json.Marshal(input)
	stale.Store(true)
	requestForTest(t, server, http.MethodPost, "/api/skills/promote", string(raw), http.StatusConflict)
	catalog, _ := db.ListPromotedSkills(context.Background())
	if len(catalog) != 0 {
		t.Fatal("stale plan wrote catalog")
	}
	stale.Store(false)
	requestForTest(t, server, http.MethodPost, "/api/skills/promote", string(raw), http.StatusCreated)
	catalog, _ = db.ListPromotedSkills(context.Background())
	if len(catalog) != 3 {
		t.Fatalf("published %d skills", len(catalog))
	}
	if scans.Load() != 1 {
		t.Fatalf("preview/promotion triggered %d scans; expected the original one only", scans.Load())
	}
	conn.Close()
	<-done
}

func TestPromotionPreviewUsesPersistedGraphWithoutDaemon(t *testing.T) {
	db := newEmptyTestStore(t)
	if err := db.ReplaceDeviceSkills(context.Background(), store.ReplaceDeviceSkillsInput{DeviceID: "offline", Skills: []store.DeviceSkill{
		{Root: "/skills", DirName: "a", Name: "a", DependenciesAnalyzed: true, SourceDigest: "snapshot"},
	}}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	response := requestForTest(t, server, http.MethodPost, "/api/skills/promote-plan", `{"deviceId":"offline","root":"/skills","dirName":"a"}`, http.StatusOK)
	var plan store.SkillPromotionPlan
	if err := json.Unmarshal(response.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.Skills) != 1 || len(plan.Problems) != 0 {
		t.Fatalf("offline saved graph: %+v", plan)
	}
}
