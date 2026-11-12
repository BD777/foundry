package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (f memoryLayersFixture) factFrom(t *testing.T, v store.KnowledgeVault, title, sourceRef string) store.KnowledgeEntry {
	t.Helper()
	job, err := f.server.knowledge.Write(context.Background(), v, knowledge.WriteRequest{RequestID: "req-" + title, Title: title, Body: title + " (body)", SourceRef: sourceRef})
	if err != nil {
		t.Fatal(err)
	}
	return applyKnowledgeWrite(t, f.assistantFixture, job)
}

// applyWriteOf is the device applying the captured write of entry
// entryID into v.
func applyWriteOf(t *testing.T, f memoryLayersFixture, vaultID, entryID string) store.KnowledgeEntry {
	t.Helper()
	jobs, err := f.server.store.ListKnowledgeMutations(context.Background(), f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range jobs {
		if job.VaultID == vaultID && job.EntryID == entryID && job.Action == "write" && job.Status != "complete" {
			return applyKnowledgeWrite(t, f.assistantFixture, job)
		}
	}
	t.Fatalf("no pending write of %s in %s: %+v", entryID, vaultID, jobs)
	return store.KnowledgeEntry{}
}

func mutationCount(t *testing.T, f memoryLayersFixture) int {
	t.Helper()
	jobs, err := f.server.store.ListKnowledgeMutations(context.Background(), f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	return len(jobs)
}

func sortOf(t *testing.T, f memoryLayersFixture, v store.KnowledgeVault, entry store.KnowledgeEntry) store.MemorySort {
	t.Helper()
	record, err := f.server.store.GetMemorySort(context.Background(), f.aliceID, knowledge.MemorySortID(v.ID, entry.ID))
	if err != nil {
		t.Fatalf("sort of %q: %v", entry.Title, err)
	}
	return record
}

// Sorting the person's layer moves what belongs to a domain to the
// assistant that wrote it (the default one when it cannot be told), and
// anything that mentions someone even when judged the person's; what is
// about the person stays. Each move is logged; sorting again changes
// nothing.
func TestMemorySortMovesDomainFactsOutOfThePersonsLayer(t *testing.T) {
	f := newMemoryLayersFixture(t)
	ctx, db := context.Background(), f.server.store
	qa := f.fact(t, f.person, "伟超是 QA，在维护一个提测 Workflow。")
	brief := f.fact(t, f.person, "我喜欢简短的回答")
	atlas := f.factFrom(t, f.person, "Atlas launches next month", "session:"+f.conversationB.ID+"/event/evt_1")
	mentioned := f.fact(t, f.person, "Prefers Feishu docs for Foundry notes")
	svc := knowledge.New(db, fakeKnowledgeDevices{db: db, user: f.aliceID, bodies: bodiesOf(qa, brief, atlas, mentioned)}, nil, nil, nil)
	placements := []knowledge.Placement{
		{EntryID: qa.ID, Belongs: "assistant", Confidence: "high", Reason: "A colleague and a workflow at work.", Mentions: []string{"伟超"}},
		{EntryID: brief.ID, Belongs: "person", Confidence: "high", Reason: "A general preference.", Mentions: []string{}},
		{EntryID: atlas.ID, Belongs: "assistant", Confidence: "medium", Reason: "A project date.", Mentions: []string{"Atlas"}},
		{EntryID: mentioned.ID, Belongs: "person", Confidence: "high", Reason: "A tool preference.", Mentions: []string{"Foundry"}},
	}
	if err := svc.SortLayer(ctx, f.a, f.person, "job_1", placements); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		entry store.KnowledgeEntry
		owner string
	}{{qa, f.a.ID}, {atlas, f.b.ID}, {mentioned, f.a.ID}} {
		record := sortOf(t, f, f.person, c.entry)
		if record.Kind != store.MemorySortMove || record.Status != store.MemorySortMoved || record.AssistantID != c.owner ||
			record.FromScope != store.MemoryScopePerson || record.ToScope != store.MemoryScopeAssistant || record.TargetEntryID == "" || record.Reason == "" || record.Title != c.entry.Title {
			t.Fatalf("sort of %q = %+v", c.entry.Title, record)
		}
		if source, _ := db.GetKnowledgeEntry(ctx, f.aliceID, f.person.ID, c.entry.ID); source.State != "forgetting" {
			t.Fatalf("%q still in the person's layer: %+v", c.entry.Title, source)
		}
	}
	if sortOf(t, f, f.person, qa).TargetVaultID != f.layerA.ID || sortOf(t, f, f.person, atlas).TargetVaultID != f.layerB.ID {
		t.Fatal("moved to the wrong assistant's layer")
	}
	if _, err := db.GetMemorySort(ctx, f.aliceID, knowledge.MemorySortID(f.person.ID, brief.ID)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a fact about the person was sorted: %v", err)
	}
	if kept, _ := db.GetKnowledgeEntry(ctx, f.aliceID, f.person.ID, brief.ID); kept.State != "active" {
		t.Fatalf("brief left the person's layer: %+v", kept)
	}
	before := mutationCount(t, f)
	if err := svc.SortLayer(ctx, f.a, f.person, "job_1", placements); err != nil {
		t.Fatal(err)
	}
	if after := mutationCount(t, f); after != before {
		t.Fatalf("sorting again wrote %d more", after-before)
	}
	records, err := db.ListMemorySorts(ctx, f.aliceID, 100)
	if err != nil || len(records) != 3 {
		t.Fatalf("records = %d %v", len(records), err)
	}
}

// Sorting an assistant's layer shares only what is about the person and
// mentions nothing, with high confidence; the uncertain becomes a
// suggestion; anything with mentions never reaches the person's layer.
// Suggestions are confirmed or dismissed; a move is undone back to its
// layer, after which it is not sorted again.
func TestMemorySortSharesSuggestsAndUndoes(t *testing.T) {
	f := newMemoryLayersFixture(t)
	ctx, db := context.Background(), f.server.store
	dark := f.fact(t, f.layerB, "Prefers dark mode")
	vim := f.fact(t, f.layerB, "Uses vim")
	lunch := f.fact(t, f.layerB, "Likes the Atlas team lunch")
	terse := f.fact(t, f.layerB, "Answers tersely")
	bodies := bodiesOf(dark, vim, lunch, terse)
	svc := knowledge.New(db, fakeKnowledgeDevices{db: db, user: f.aliceID, bodies: bodies}, nil, nil, nil)
	placements := []knowledge.Placement{
		{EntryID: dark.ID, Belongs: "person", Confidence: "high", Reason: "A general preference.", Mentions: []string{}},
		{EntryID: vim.ID, Belongs: "person", Confidence: "medium", Reason: "Maybe only at work.", Mentions: nil},
		{EntryID: lunch.ID, Belongs: "person", Confidence: "high", Reason: "Social preference.", Mentions: []string{"Atlas"}},
		{EntryID: terse.ID, Belongs: "person", Confidence: "low", Reason: "Unclear.", Mentions: []string{}},
	}
	if err := svc.SortLayer(ctx, f.b, f.layerB, "job_b", placements); err != nil {
		t.Fatal(err)
	}
	if err := svc.SortLayer(ctx, f.a, f.layerB, "job_b", placements); err == nil {
		t.Fatal("A sorted B's layer")
	}
	moved := sortOf(t, f, f.layerB, dark)
	if moved.Kind != store.MemorySortMove || moved.Status != store.MemorySortMoved || moved.TargetVaultID != f.person.ID || moved.AssistantID != f.b.ID {
		t.Fatalf("dark mode = %+v", moved)
	}
	if s := sortOf(t, f, f.layerB, vim); s.Kind != store.MemorySortSuggestion || s.Status != store.MemorySortSuggested {
		t.Fatalf("vim = %+v", s)
	}
	if _, err := db.GetMemorySort(ctx, f.aliceID, knowledge.MemorySortID(f.layerB.ID, lunch.ID)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an entry with mentions was sorted toward the person's layer: %v", err)
	}
	if kept, _ := db.GetKnowledgeEntry(ctx, f.aliceID, f.layerB.ID, lunch.ID); kept.State != "active" {
		t.Fatalf("lunch left B's layer: %+v", kept)
	}

	moves, suggestions, err := svc.SortRecords(ctx, f.aliceID)
	if err != nil || len(moves) != 1 || moves[0].Undoable || len(suggestions) != 2 {
		t.Fatalf("records before apply: %+v %+v %v", moves, suggestions, err)
	}
	// The listing as the web reads it, and a dismiss through the route.
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/assistants/"+f.b.ID+"/memory/sorting", ""))
	expectStatus(t, recorder, http.StatusOK, "GET memory/sorting")
	var listed store.MemorySortList
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil || len(listed.Moves) != 1 || len(listed.Suggestions) != 2 || listed.Moves[0].AssistantID != f.b.ID {
		t.Fatalf("listed = %+v %v", listed, err)
	}
	terseID := knowledge.MemorySortID(f.layerB.ID, terse.ID)
	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/assistants/"+f.b.ID+"/memory/sorting/"+terseID+"/action", `{"action":"dismiss"}`))
	expectStatus(t, recorder, http.StatusOK, "dismiss")
	if s, _ := db.GetMemorySort(ctx, f.aliceID, terseID); s.Status != store.MemorySortDismissed {
		t.Fatalf("dismissed = %+v", s)
	}
	recorder = doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/assistants/"+f.b.ID+"/memory/sorting", ""))
	expectStatus(t, recorder, http.StatusNotFound, "bob reads alice's sorting")

	confirmed, err := svc.SortAction(ctx, f.aliceID, knowledge.MemorySortID(f.layerB.ID, vim.ID), "confirm")
	if err != nil || confirmed.Status != store.MemorySortConfirmed || confirmed.TargetVaultID != f.person.ID {
		t.Fatalf("confirm = %+v %v", confirmed, err)
	}
	if source, _ := db.GetKnowledgeEntry(ctx, f.aliceID, f.layerB.ID, vim.ID); source.State != "forgetting" {
		t.Fatalf("confirmed suggestion did not move: %+v", source)
	}
	if _, suggestions, _ = svc.SortRecords(ctx, f.aliceID); len(suggestions) != 0 {
		t.Fatalf("suggestions left: %+v", suggestions)
	}

	shared := applyWriteOf(t, f, f.person.ID, moved.TargetEntryID)
	bodies[shared.ID] = dark.Title + " (body)"
	if moves, _, _ = svc.SortRecords(ctx, f.aliceID); !moves[0].Undoable {
		t.Fatalf("applied move not undoable: %+v", moves)
	}
	undone, err := svc.SortAction(ctx, f.aliceID, moved.ID, "undo")
	if err != nil || undone.Status != store.MemorySortUndone {
		t.Fatalf("undo = %+v %v", undone, err)
	}
	if source, _ := db.GetKnowledgeEntry(ctx, f.aliceID, f.person.ID, shared.ID); source.State != "forgetting" {
		t.Fatalf("undo left the shared copy: %+v", source)
	}
	var back store.KnowledgeMutation
	jobs, _ := db.ListKnowledgeMutations(ctx, f.aliceID)
	for _, job := range jobs {
		if job.VaultID == f.layerB.ID && job.Action == "write" && job.Title == dark.Title && job.Status != "complete" {
			back = job
		}
	}
	if back.ID == "" {
		t.Fatal("undo wrote nothing back to B's layer")
	}
	var refusal *personalagent.Refusal
	if _, err = svc.SortAction(ctx, f.aliceID, moved.ID, "undo"); !errors.As(err, &refusal) || refusal.Status != http.StatusConflict {
		t.Fatalf("second undo: %v", err)
	}
	restored := applyKnowledgeWrite(t, f.assistantFixture, back)
	bodies[restored.ID] = dark.Title + " (body)"
	before := mutationCount(t, f)
	if err := svc.SortLayer(ctx, f.b, f.layerB, "job_b2", []knowledge.Placement{{EntryID: restored.ID, Belongs: "person", Confidence: "high", Reason: "A general preference."}}); err != nil {
		t.Fatal(err)
	}
	if after := mutationCount(t, f); after != before {
		t.Fatal("an undone entry was sorted again")
	}
}

// The first run reviews each person's layer once (the sorting version is in
// its key): capturing again queues nothing new. While the default assistant
// is stopped, the person's layer is reviewed as the first active one.
func TestMemorySortFirstRunIsOnceAndSurvivesAStoppedDefault(t *testing.T) {
	f := newMemoryLayersFixture(t)
	ctx, db := context.Background(), f.server.store
	f.fact(t, f.person, "Person fact")
	f.fact(t, f.layerB, "B fact")
	if _, err := db.SetPersonalAgentState(ctx, f.a.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	count := func() map[string][]store.PersonalAgentMaintenance {
		jobs := map[string][]store.PersonalAgentMaintenance{}
		for _, agent := range []store.PersonalAgent{f.a, f.b} {
			list, err := db.ListPersonalAgentMaintenance(ctx, agent.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, job := range list {
				if job.Role == "memory" {
					jobs[job.VaultID] = append(jobs[job.VaultID], job)
				}
			}
		}
		return jobs
	}
	f.server.assistant.CaptureMaintenanceEvents(ctx)
	f.server.assistant.CaptureMaintenanceEvents(ctx)
	jobs := count()
	if len(jobs[f.person.ID]) != 1 || jobs[f.person.ID][0].AssistantID != f.b.ID || len(jobs[f.layerB.ID]) != 1 || len(jobs[f.layerA.ID]) != 0 {
		t.Fatalf("memory reviews = %+v", jobs)
	}
	text, err := f.server.assistant.MaintenancePrompt(ctx, jobs[f.person.ID][0])
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Sorting between layers", "the person's shared layer", "knowledge/<id>.md", `"placements"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("person's layer review lacks %q: %s", want, text)
		}
	}
}

func bodiesOf(entries ...store.KnowledgeEntry) map[string]string {
	bodies := map[string]string{}
	for _, entry := range entries {
		bodies[entry.ID] = entry.Title + " (body)"
	}
	return bodies
}
