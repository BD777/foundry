package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
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
	httpServer := serveForTest(t, server)
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
				// The scan every worker gets on connecting covers other
				// roots; only the explicit one is counted.
				var scan wsScanSkillsPayload
				_ = json.Unmarshal(request.Payload, &scan)
				if slices.Equal(scan.Roots, []string{"~/.claude/skills"}) {
					scans.Add(1)
				}
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
	if _, _, err := server.hub.ScanDeviceSkills(context.Background(), "dev_deps", []string{"~/.claude/skills"}); err != nil {
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
	if _, err := db.ReplaceDeviceSkills(context.Background(), store.ReplaceDeviceSkillsInput{DeviceID: "offline", Skills: []store.DeviceSkill{
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

// A reviewed draft closure publishes verified snapshots, advances its checkout
// base, and selects both nodes atomically.
func TestPublishDraftClosureAndRevisionGuards(t *testing.T) {
	ctx := context.Background()
	db := newEmptyTestStore(t)
	s := NewServer(db)
	h := serveForTest(t, s)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	const ws = "ws_draft_publish"
	const device = "dev_draft_publish"
	writeWSForTest(t, conn, "hello", map[string]any{"device": map[string]any{"id": device, "label": "publish", "status": "connected"}, "workspace": map[string]any{"id": ws, "name": "publish", "baseline": "main", "localPath": "/tmp/pub"}})
	readWSTypeForTest(t, conn, "registered")
	archives := map[string][]byte{}
	drafts := store.WorkspaceDraftSkills{Enabled: true}
	for _, name := range []string{"primary", "helper"} {
		data, idx := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: " + name + "\n---\nnew"})
		archives[name] = data
		drafts.Skills = append(drafts.Skills, store.WorkspaceDraftSkill{ID: name, WorkspaceID: ws, ExecutionRootID: ws, Name: name, Status: "ready", RelativePath: ".agents/skills/" + name, Digest: idx.SourceDigest, SourceDigest: idx.SourceDigest, DependenciesAnalyzed: true})
	}
	drafts.Skills[0].Dependencies = []store.SkillDependency{{SkillName: "helper", Strength: store.SkillDependencyRequired, Status: "resolved", TargetRoot: ws, TargetDirName: drafts.Skills[1].RelativePath}}
	if err := db.SaveWorkspaceDrafts(ctx, ws, ws, drafts); err != nil {
		t.Fatal(err)
	}
	origin := store.PromoteSkillInput{DeviceID: device, Root: "legacy", DirName: "primary"}
	var target store.PromotedSkill
	for _, body := range []string{"base", "upstream"} {
		zip, _ := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: primary\n---\n" + body})
		target, _, err = db.AddPromotedSkillRevision(ctx, origin, "primary", "", zip, 1)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := db.SaveWorkspaceSkillCheckout(ctx, ws, drafts.Skills[0].RelativePath, store.SkillCheckoutBaseline{SkillID: target.ID, Revision: 1}); err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			var req wsEnvelope
			if conn.ReadJSON(&req) != nil {
				return
			}
			var kind string
			var answer any
			switch req.Type {
			case wsReadSkillContentType:
				var body struct {
					Draft store.WorkspaceDraftSkill `json:"draft"`
				}
				_ = json.Unmarshal(req.Payload, &body)
				kind = wsSkillContentReadType
				answer = wsSkillContentReadPayload{Name: body.Draft.Name, SourceDigest: body.Draft.SourceDigest, ContentB64: base64.StdEncoding.EncodeToString(archives[body.Draft.Name]), FileCount: 1}
			case wsScanSkillsType:
				kind = wsSkillsScannedType
				answer = wsSkillsScannedPayload{}
			default:
				continue
			}
			raw, _ := json.Marshal(answer)
			if conn.WriteJSON(wsEnvelope{ID: req.ID, Type: kind, Payload: raw}) != nil {
				return
			}
		}
	}()
	revision := 2
	input := store.PromoteSkillInput{SourceWorkspaceID: ws, DraftID: "primary", WorkspaceID: ws, ExpectedRevision: &revision}
	call := func(path string, status int) []byte {
		t.Helper()
		raw, _ := json.Marshal(input)
		return requestForTest(t, s, http.MethodPost, path, string(raw), status).Body.Bytes()
	}
	if body := string(call("/api/skills/publish", http.StatusConflict)); !strings.Contains(body, "merge") {
		t.Fatal(body)
	}
	input.MergedLatest = true
	var plan store.SkillPromotionPlan
	if err := json.Unmarshal(call("/api/skills/promote-plan", http.StatusOK), &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.Skills) != 2 || len(plan.Problems) > 0 {
		t.Fatalf("closure: %+v", plan)
	}
	input.PlanDigest = plan.Digest
	var item store.PromotedSkill
	if err := json.Unmarshal(call("/api/skills/publish", http.StatusCreated), &item); err != nil {
		t.Fatal(err)
	}
	if item.ID != target.ID || item.LatestRevision != 3 {
		t.Fatalf("publication: %+v", item)
	}
	bindings, err := db.ListWorkspaceSkillBindings(ctx, ws)
	if err != nil || len(bindings) != 2 {
		t.Fatalf("selection: %v %v", bindings, err)
	}
	bases, err := db.WorkspaceSkillCheckouts(ctx, ws)
	if err != nil || bases[drafts.Skills[0].RelativePath].Revision != 3 {
		t.Fatalf("base: %v %v", bases, err)
	}
	if body := string(call("/api/skills/publish", http.StatusConflict)); !strings.Contains(body, "compare again") {
		t.Fatal(body)
	}
	// Two writers compared revision 3. Exactly one can replace it; the other
	// is refused even if both built their plans before either committed.
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, body := range []string{"concurrent A", "concurrent B"} {
		zip, idx := comparisonArchive(t, map[string]string{"SKILL.md": body})
		pkg := store.SkillPromotionPackage{Source: store.DeviceSkill{DeviceID: device, Root: ws, DirName: drafts.Skills[0].RelativePath, Name: "primary", SourceDigest: idx.SourceDigest}, Resolution: store.SkillPromotionResolution{Action: "update", TargetSkillID: item.ID, ExpectedRevision: item.LatestRevision}, Content: zip, DraftWorkspaceID: ws}
		go func() {
			<-start
			_, err := db.PromoteSkillPackages(ctx, []store.SkillPromotionPackage{pkg})
			results <- err
		}()
	}
	close(start)
	first, second := <-results, <-results
	if !((first == nil && errors.Is(second, store.ErrSkillVersionConflict)) || (second == nil && errors.Is(first, store.ErrSkillVersionConflict))) {
		t.Fatalf("concurrent results: %v, %v", first, second)
	}

}

func TestPublishSkillTool(t *testing.T) {
	f := newExternalAccountsFixture(t)
	source := store.DeviceSkill{Name: "demo", Root: "root", DirName: "demo", SourceDigest: "source", DependenciesAnalyzed: true}
	if _, err := f.db.ReplaceDeviceSkills(context.Background(), store.ReplaceDeviceSkillsInput{DeviceID: "dev_alice", Skills: []store.DeviceSkill{source}}); err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, f.handler, skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID}))
	args := map[string]any{"deviceId": "dev_alice", "root": "root", "dirName": "demo", "expectedRevision": 0, "preview": true}
	if result, failed := call("publish_skill", args); failed || !strings.Contains(result, "planDigest") {
		t.Fatal(result)
	}
	reader := mcpToolCaller(t, f.handler, skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceAccess: store.SessionWorkspaceAccessRead}))
	if result, failed := reader("publish_skill", args); !failed || !strings.Contains(result, "read-only") {
		t.Fatalf("read-only session: %s", result)
	}

	args["workspaceId"] = "ws_alice"
	if result, failed := call("publish_skill", args); !failed {
		t.Fatalf("session exceeds member cap: %s", result)
	}
	delete(args, "workspaceId")
	args["deviceId"] = "dev_bob"
	if result, failed := call("publish_skill", args); !failed {
		t.Fatalf("other owner's device: %s", result)
	}
}
