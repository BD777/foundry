package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// memoryLayersFixture is alice with two assistants: A (the default, home
// ws_pa) and B (home ws_alice), the person's layer in ws_alice and each
// assistant's own layer in its home, all active.
type memoryLayersFixture struct {
	assistantFixture
	a, b                   store.PersonalAgent
	person, layerA, layerB store.KnowledgeVault
	conversationB          store.AgentSession
}

func newMemoryLayersFixture(t *testing.T) memoryLayersFixture {
	t.Helper()
	f := memoryLayersFixture{assistantFixture: newAssistantFixture(t)}
	ctx, db := context.Background(), f.server.store
	f.a = defaultAssistantOf(t, f.server, f.aliceID)
	var err error
	if f.b, err = db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, WorkspaceID: "ws_alice", HomeDeviceID: "dev_alice", Settings: personalagent.DefaultSettings()}); err != nil {
		t.Fatal(err)
	}
	if f.person, err = db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: knowledge.MemoryLayerID(f.aliceID, ""), UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"}); err != nil {
		t.Fatal(err)
	}
	if f.layerA, err = f.server.knowledge.EnsureMemoryLayer(ctx, f.a, store.MemoryScopeAssistant); err != nil {
		t.Fatal(err)
	}
	if f.layerB, err = f.server.knowledge.EnsureMemoryLayer(ctx, f.b, store.MemoryScopeAssistant); err != nil {
		t.Fatal(err)
	}
	for _, v := range []*store.KnowledgeVault{&f.person, &f.layerA, &f.layerB} {
		v.State = "active"
		if *v, err = db.SaveKnowledgeVault(ctx, *v); err != nil {
			t.Fatal(err)
		}
	}
	f.conversationB = f.startSession(t, "ws_alice", "", "hello B")
	return f
}

// applyKnowledgeWrite is the vault's device confirming job, as
// knowledge.drainMutations records it.
func applyKnowledgeWrite(t *testing.T, f assistantFixture, job store.KnowledgeMutation) store.KnowledgeEntry {
	t.Helper()
	ctx := context.Background()
	current, err := f.server.store.GetKnowledgeMutation(ctx, f.aliceID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.Status, current.LeaseUntil = "writing", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	claimed, err := f.server.store.SaveKnowledgeMutation(ctx, current)
	if err != nil {
		t.Fatal(err)
	}
	doc := store.KnowledgeDocument{ID: claimed.EntryID, Revision: 1, OperationID: claimed.ID, Hash: "sha256:" + claimed.EntryID, SourceRef: claimed.SourceRef, SourceVersion: claimed.SourceVersion, ExpiresAt: claimed.ExpiresAt, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err = f.server.store.CompleteKnowledgeMutation(ctx, claimed, doc); err != nil {
		t.Fatal(err)
	}
	entry, err := f.server.store.GetKnowledgeEntry(ctx, f.aliceID, claimed.VaultID, claimed.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func (f memoryLayersFixture) fact(t *testing.T, v store.KnowledgeVault, title string) store.KnowledgeEntry {
	t.Helper()
	job, err := f.server.knowledge.Write(context.Background(), v, knowledge.WriteRequest{RequestID: "req-" + title, Title: title, Body: title + " (body)"})
	if err != nil {
		t.Fatal(err)
	}
	return applyKnowledgeWrite(t, f.assistantFixture, job)
}

// An assistant recalls the person's layer and its own, never another
// assistant's: in its turn's context, read_memory, listSources, remember
// and memory publications. A new assistant's layer is made in its home.
func TestMemoryLayersRecallPersonAndOwnLayerOnly(t *testing.T) {
	f := newMemoryLayersFixture(t)
	ctx := context.Background()
	if f.layerA.WorkspaceID != "ws_pa" || f.layerA.RootPath != knowledge.AssistantMemoryRoot || f.layerA.Scope != store.MemoryScopeAssistant || f.layerA.AssistantID != f.a.ID {
		t.Fatalf("assistant layer = %+v", f.layerA)
	}
	if f.person.Scope != store.MemoryScopePerson || f.person.AssistantID != "" {
		t.Fatalf("person layer = %+v", f.person)
	}
	f.fact(t, f.person, "Person fact tea")
	f.fact(t, f.layerA, "Atlas fact")
	f.fact(t, f.layerB, "Family fact")

	input, err := f.server.assistant.PromptInput(ctx, f.a, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	turn := prompt.AgentsFile(input)
	if !strings.Contains(turn, "Person fact tea") || !strings.Contains(turn, "Atlas fact") || strings.Contains(turn, "Family fact") || !strings.Contains(turn, ", every assistant") || !strings.Contains(turn, ", only you") {
		t.Fatalf("A's AGENTS.md:\n%s", turn)
	}
	text, failed := f.tool(t, f.token, "read_memory", map[string]any{})
	if failed || !strings.Contains(text, "Person fact tea") || !strings.Contains(text, "Atlas fact") || strings.Contains(text, "Family fact") || !strings.Contains(text, `"scope": "person"`) {
		t.Fatalf("A's read_memory = %s", text)
	}
	tokenB := f.mint(t, f.conversationB.ID)
	text, failed = f.tool(t, tokenB, "read_memory", map[string]any{})
	if failed || !strings.Contains(text, "Person fact tea") || !strings.Contains(text, "Family fact") || strings.Contains(text, "Atlas fact") {
		t.Fatalf("B's read_memory = %s", text)
	}
	text, failed = f.tool(t, f.token, "read_knowledge", map[string]any{"listSources": true})
	if failed || !strings.Contains(text, f.person.ID) || !strings.Contains(text, f.layerA.ID) || strings.Contains(text, f.layerB.ID) {
		t.Fatalf("A's sources = %s", text)
	}
	text, failed = f.tool(t, f.token, "remember", map[string]any{"op": "add", "item": map[string]any{"vaultId": f.layerB.ID, "intentKey": "week", "title": "Week", "content": "Wants help with the week", "quote": "help me with my week"}})
	if !failed {
		t.Fatalf("A wrote into B's layer: %s", text)
	}

	audience, err := f.server.knowledge.Audience(ctx, f.aliceID, "ws_pa")
	if err != nil {
		t.Fatal(err)
	}
	config := bindSyntheticKnowledgeAccount(t, f.assistantFixture, "ws_pa", "chosen", "fingerprint", "Synthetic account A")
	session := f.conversation
	session.ProfileID, session.ProfileFingerprint = "chosen", "fingerprint"
	for _, grant := range []struct {
		vault   store.KnowledgeVault
		recalls bool
	}{{f.person, true}, {f.layerA, true}, {f.layerB, false}} {
		p, err := f.server.store.CreateKnowledgePublication(ctx, store.KnowledgePublication{ID: "grant-" + grant.vault.ID, UserID: f.aliceID, Scope: "memory_root", VaultID: grant.vault.ID, SourceEpoch: grant.vault.Epoch, TargetWorkspaceID: "ws_pa", ProfileID: "chosen", ProfileFingerprint: "fingerprint", ProviderConfigHash: config, AudienceHash: audience, Purpose: "assistant_memory_recall"})
		if err != nil {
			t.Fatal(err)
		}
		if err = f.server.knowledge.CheckPublication(ctx, session, p); (err == nil) != grant.recalls {
			t.Errorf("publication of %s to A: %v, want recalled %v", grant.vault.ID, err, grant.recalls)
		}
	}

	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/assistants/"+f.b.ID+"/memory/layers", ""))
	var layers store.AssistantMemoryLayers
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &layers) != nil || len(layers.Layers) != 2 {
		t.Fatalf("B's layers: %d %s", response.Code, response.Body.String())
	}
	if layers.Layers[0].Scope != store.MemoryScopePerson || layers.Layers[1].VaultID != f.layerB.ID || len(layers.Layers[1].Entries) != 1 || layers.Layers[1].Entries[0].Scope != store.MemoryScopeAssistant {
		t.Fatalf("B's layers = %s", response.Body.String())
	}
}

// remember writes a new fact into the assistant's own layer unless the
// assistant asks for the person's.
func TestRememberWritesAssistantLayerByDefaultAndPersonOnRequest(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	person, err := f.server.store.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: knowledge.MemoryLayerID(f.aliceID, ""), UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	session := f.startSession(t, "ws_pa", "", "Call me Ali. I lead Project Atlas.")
	token := f.mint(t, session.ID)
	written := func(args map[string]any) store.KnowledgeMutation {
		t.Helper()
		text, failed := f.tool(t, token, "remember", args)
		var answer struct {
			Status    string
			Scope     string
			Operation store.KnowledgeMutation
		}
		if err := json.Unmarshal([]byte(text), &answer); failed || err != nil || answer.Status != "captured" {
			t.Fatalf("remember %v: %s", args, text)
		}
		return answer.Operation
	}
	atlas := written(map[string]any{"op": "add", "item": map[string]any{"intentKey": "atlas", "title": "Leads Atlas", "content": "Leads Project Atlas", "quote": "I lead Project Atlas"}})
	own := knowledge.MemoryLayerID(f.aliceID, agent.ID)
	if atlas.VaultID != own {
		t.Fatalf("default scope wrote into %s, want the assistant's layer %s", atlas.VaultID, own)
	}
	layer, err := f.server.store.GetKnowledgeVault(ctx, f.aliceID, own)
	if err != nil || layer.Scope != store.MemoryScopeAssistant || layer.AssistantID != agent.ID || layer.WorkspaceID != "ws_pa" || layer.RootPath != knowledge.AssistantMemoryRoot {
		t.Fatalf("assistant layer = %+v %v", layer, err)
	}
	name := written(map[string]any{"op": "add", "scope": "person", "item": map[string]any{"intentKey": "name", "title": "Name", "content": "Wants to be called Ali", "quote": "Call me Ali"}})
	if name.VaultID != person.ID {
		t.Fatalf("scope person wrote into %s, want %s", name.VaultID, person.ID)
	}
	if text, failed := f.tool(t, token, "remember", map[string]any{"op": "add", "scope": "team", "item": map[string]any{"intentKey": "x", "title": "X", "content": "Leads Project Atlas", "quote": "I lead Project Atlas"}}); !failed {
		t.Fatalf("unknown scope accepted: %s", text)
	}
	if legacy, _ := f.server.store.ListPersonalAgentMemory(ctx, f.aliceID); len(legacy) != 0 {
		t.Fatalf("remember wrote legacy memory: %+v", legacy)
	}
}

// Confirmed legacy facts are copied once into the person's layer and stay,
// read-only, in pa_memory; the turn then reads the copy from the layer.
func TestLegacyMemoryCopiesOnceAndTurnReadsTheLayer(t *testing.T) {
	f := newMemoryLayersFixture(t)
	ctx, db := context.Background(), f.server.store
	legacy, err := db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: f.aliceID, AssistantID: f.a.ID, Content: "Prefers window seats", Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryActive})
	if err != nil {
		t.Fatal(err)
	}
	guess, err := db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: f.aliceID, Content: "Probably an early riser", Origin: store.PersonalAgentMemoryInferred, Status: store.PersonalAgentMemoryActive})
	if err != nil {
		t.Fatal(err)
	}
	memory := func() map[string]store.PersonalAgentMemoryItem {
		t.Helper()
		input, err := f.server.assistant.PromptInput(ctx, f.a, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		byID := map[string]store.PersonalAgentMemoryItem{}
		for _, item := range input.Memory {
			byID[item.ID] = item
		}
		return byID
	}
	if _, ok := memory()[legacy.ID]; !ok {
		t.Fatal("an uncopied legacy fact left the turn")
	}
	copies := func() []store.KnowledgeMutation {
		t.Helper()
		jobs, err := db.ListKnowledgeMutations(ctx, f.aliceID)
		if err != nil {
			t.Fatal(err)
		}
		found := []store.KnowledgeMutation{}
		for _, job := range jobs {
			if strings.HasPrefix(job.SourceRef, "legacy-memory:") {
				found = append(found, job)
			}
		}
		return found
	}
	f.server.knowledge.Drain(ctx)
	f.server.knowledge.Drain(ctx)
	jobs := copies()
	if len(jobs) != 1 || jobs[0].VaultID != f.person.ID || jobs[0].SourceRef != "legacy-memory:"+legacy.ID {
		t.Fatalf("legacy copies = %+v", jobs)
	}
	status, err := db.LegacyMemoryCopies(ctx, f.aliceID)
	if err != nil || status[legacy.ID] != "copying" || status[guess.ID] != "" {
		t.Fatalf("copy status = %v %v", status, err)
	}
	entry := applyKnowledgeWrite(t, f.assistantFixture, jobs[0])
	f.server.knowledge.Drain(ctx)
	if again := copies(); len(again) != 1 {
		t.Fatalf("a copied fact was copied again: %+v", again)
	}
	if status, _ = db.LegacyMemoryCopies(ctx, f.aliceID); status[legacy.ID] != "copied" {
		t.Fatalf("copy status after receipt = %v", status)
	}
	turn := memory()
	if _, ok := turn[legacy.ID]; ok {
		t.Fatal("the turn still reads the legacy row after its copy")
	}
	if item, ok := turn[entry.ID]; !ok || item.Scope != store.MemoryScopePerson || !strings.Contains(item.Content, "window seats") {
		t.Fatalf("the turn does not read the copy from the person's layer: %+v", turn)
	}
	kept, err := db.GetPersonalAgentMemory(ctx, f.aliceID, legacy.ID)
	if err != nil || kept.Status != store.PersonalAgentMemoryActive || kept.Content != "Prefers window seats" {
		t.Fatalf("legacy row not kept for rollback: %+v %v", kept, err)
	}
	if response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/memory", `{"content":"New legacy fact"}`)); response.Code != http.StatusConflict {
		t.Fatalf("legacy add: %d %s", response.Code, response.Body.String())
	}
}

// fakeKnowledgeDevices answers a vault read with the indexed revision and
// body.
type fakeKnowledgeDevices struct {
	db     store.KnowledgeEntryStore
	user   string
	bodies map[string]string
}

func (d fakeKnowledgeDevices) KnowledgeCommand(ctx context.Context, _ store.WorkspaceProjection, command store.KnowledgeCommand) (store.KnowledgeReply, error) {
	if command.Action != "read" {
		return store.KnowledgeReply{}, errors.New("memory_device_offline")
	}
	entry, err := d.db.GetKnowledgeEntry(ctx, d.user, command.VaultID, command.DocumentID)
	if err != nil {
		return store.KnowledgeReply{}, err
	}
	return store.KnowledgeReply{VaultID: command.VaultID, Epoch: command.Epoch, State: "active", Document: &store.KnowledgeDocument{ID: entry.ID, Revision: entry.Revision, Hash: entry.Hash, Body: d.bodies[entry.ID], SourceRef: entry.SourceRef, SourceVersion: entry.SourceVersion, ExpiresAt: entry.ExpiresAt, UpdatedAt: entry.UpdatedAt}}, nil
}

// Moving an entry writes its current body into the other layer and forgets
// the source, once; a stale revision is refused.
func TestMoveMemoryEntryBetweenLayers(t *testing.T) {
	f := newMemoryLayersFixture(t)
	ctx, db := context.Background(), f.server.store
	tea := f.fact(t, f.layerA, "Prefers green tea")
	svc := knowledge.New(db, fakeKnowledgeDevices{db: db, user: f.aliceID, bodies: map[string]string{tea.ID: "Prefers green tea, no sugar"}}, nil, nil, nil)
	move, err := svc.MoveEntry(ctx, f.a, tea.ID, knowledge.Move{ToScope: store.MemoryScopePerson, ExpectedRevision: tea.Revision, ExpectedHash: tea.Hash})
	if err != nil {
		t.Fatal(err)
	}
	if move.FromScope != store.MemoryScopeAssistant || move.TargetVaultID != f.person.ID || move.TargetEntryID == "" {
		t.Fatalf("move = %+v", move)
	}
	jobs, err := db.ListKnowledgeMutations(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	var write, forget int
	for _, job := range jobs {
		switch {
		case job.VaultID == f.person.ID && job.EntryID == move.TargetEntryID && job.Action == "write":
			full, _ := db.GetKnowledgeMutation(ctx, f.aliceID, job.ID)
			if full.Body != "Prefers green tea, no sugar" || full.Title != "Prefers green tea" || !strings.HasPrefix(full.SourceRef, "memory-move:") {
				t.Fatalf("moved write = %+v", full)
			}
			write++
		case job.VaultID == f.layerA.ID && job.EntryID == tea.ID && job.Action == "forget":
			forget++
		}
	}
	if write != 1 || forget != 1 {
		t.Fatalf("move jobs: %d writes, %d forgets: %+v", write, forget, jobs)
	}
	if source, _ := db.GetKnowledgeEntry(ctx, f.aliceID, f.layerA.ID, tea.ID); source.State != "forgetting" {
		t.Fatalf("source not revoked: %+v", source)
	}
	replay, err := svc.MoveEntry(ctx, f.a, tea.ID, knowledge.Move{ToScope: store.MemoryScopePerson, ExpectedRevision: tea.Revision, ExpectedHash: tea.Hash})
	if err != nil || replay.TargetEntryID != move.TargetEntryID {
		t.Fatalf("replay = %+v %v", replay, err)
	}
	if again, _ := db.ListKnowledgeMutations(ctx, f.aliceID); len(again) != len(jobs) {
		t.Fatal("a replayed move wrote again")
	}
	atlas := f.fact(t, f.layerA, "Atlas")
	_, err = svc.MoveEntry(ctx, f.a, atlas.ID, knowledge.Move{ToScope: store.MemoryScopePerson, ExpectedRevision: atlas.Revision, ExpectedHash: "sha256:stale"})
	var refusal *personalagent.Refusal
	if !errors.As(err, &refusal) || refusal.Status != http.StatusConflict {
		t.Fatalf("stale move: %v", err)
	}
}

// Memory upkeep reviews each layer by itself, as the assistant whose layer
// it is; a review reads only its own vault's index.
func TestMemoryReviewReadsOneVault(t *testing.T) {
	f := newMemoryLayersFixture(t)
	ctx := context.Background()
	personFact := f.fact(t, f.person, "Person fact")
	factA := f.fact(t, f.layerA, "A fact")
	factB := f.fact(t, f.layerB, "B fact")
	f.server.assistant.CaptureMaintenanceEvents(ctx)
	reviews := map[string]store.PersonalAgentMaintenance{}
	for _, agent := range []store.PersonalAgent{f.a, f.b} {
		jobs, err := f.server.store.ListPersonalAgentMaintenance(ctx, agent.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, job := range jobs {
			if job.Role == "memory" {
				reviews[job.VaultID] = job
			}
		}
	}
	if len(reviews) != 3 || reviews[f.layerB.ID].AssistantID != f.b.ID || reviews[f.layerA.ID].AssistantID != f.a.ID || reviews[f.person.ID].AssistantID != f.a.ID {
		t.Fatalf("memory reviews = %+v", reviews)
	}
	entries := map[string]string{f.person.ID: personFact.ID, f.layerA.ID: factA.ID, f.layerB.ID: factB.ID}
	for vault, job := range reviews {
		text, err := f.server.assistant.MaintenancePrompt(ctx, job)
		if err != nil {
			t.Fatal(err)
		}
		for other, entry := range entries {
			if strings.Contains(text, other) != (other == vault) || strings.Contains(text, entry) != (other == vault) {
				t.Errorf("review of %s and %s (entry %s): %s", vault, other, entry, text)
			}
		}
	}
	stolen := reviews[f.layerB.ID]
	stolen.AssistantID = f.a.ID
	if _, err := f.server.assistant.MaintenancePrompt(ctx, stolen); err == nil {
		t.Fatal("A's review read B's layer")
	}
}
