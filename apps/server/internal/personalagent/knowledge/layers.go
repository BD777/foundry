package knowledge

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The layers of the person's memory (DEV-191 P2). Every memory vault is one
// layer: the person's (store.MemoryScopePerson, one per person, recalled by
// every assistant of theirs) or one assistant's (store.MemoryScopeAssistant,
// recalled by that assistant only). An assistant recalls exactly the
// person's layer and its own; no assistant reads another's.

// AssistantMemoryRoot is the folder of an assistant's layer in its home
// workspace.
const AssistantMemoryRoot = ".foundry/memory"

// MemoryLayerID is the vault id of a layer: the person's when assistantID
// is empty (the id their one memory vault always had), else that
// assistant's.
func MemoryLayerID(user, assistantID string) string {
	if assistantID == "" {
		return flow.Key("vault", user, "memory")
	}
	return flow.Key("vault", user, "memory", assistantID)
}

// ValidMemoryScope is whether scope names a layer.
func ValidMemoryScope(scope string) bool {
	return scope == store.MemoryScopePerson || scope == store.MemoryScopeAssistant
}

func layerAssistant(agent store.PersonalAgent, scope string) string {
	if scope == store.MemoryScopePerson {
		return ""
	}
	return agent.ID
}

// Recalls is whether agent may read v: any domain source of its person, and
// of memory only the person's layer and its own.
func Recalls(agent store.PersonalAgent, v store.KnowledgeVault) bool {
	if v.UserID != agent.UserID {
		return false
	}
	return v.Kind != "memory" || v.AssistantID == "" || v.AssistantID == agent.ID
}

// MemoryLayer is agent's layer scope as recorded; store.ErrNotFound until
// it is created.
func (s *Service) MemoryLayer(ctx context.Context, agent store.PersonalAgent, scope string) (store.KnowledgeVault, error) {
	if !ValidMemoryScope(scope) {
		return store.KnowledgeVault{}, invalid("scope must be person or assistant")
	}
	return s.store.GetKnowledgeVault(ctx, agent.UserID, MemoryLayerID(agent.UserID, layerAssistant(agent, scope)))
}

// EnsureMemoryLayer is agent's layer scope, created the first time it is
// needed: an assistant's in its home workspace (AssistantMemoryRoot), the
// person's as their private Personal Memory workspace on the assistant's
// home device (CreateVault). Either is initialized on its device later
// (drainVaults); writes queue until then.
func (s *Service) EnsureMemoryLayer(ctx context.Context, agent store.PersonalAgent, scope string) (store.KnowledgeVault, error) {
	v, err := s.MemoryLayer(ctx, agent, scope)
	if !errors.Is(err, store.ErrNotFound) {
		return v, err
	}
	if scope == store.MemoryScopePerson {
		v, _, err = s.CreateVault(ctx, agent.UserID, VaultRequest{Kind: "memory", CreateNew: true, DeviceID: agent.HomeDeviceID})
		return v, err
	}
	home, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil {
		return store.KnowledgeVault{}, err
	}
	v = store.KnowledgeVault{ID: MemoryLayerID(agent.UserID, agent.ID), UserID: agent.UserID, AssistantID: agent.ID, Kind: "memory", WorkspaceID: home.ID, DeviceID: home.DeviceID, RootPath: AssistantMemoryRoot}
	if _, err = s.Workspace(ctx, agent.UserID, v); err != nil {
		return store.KnowledgeVault{}, err
	}
	return s.store.CreateKnowledgeVault(ctx, v)
}

// MemoryLayers are agent's layers that exist, the person's first.
func (s *Service) MemoryLayers(ctx context.Context, agent store.PersonalAgent) ([]store.KnowledgeVault, error) {
	layers := []store.KnowledgeVault{}
	for _, scope := range []string{store.MemoryScopePerson, store.MemoryScopeAssistant} {
		v, err := s.MemoryLayer(ctx, agent, scope)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		layers = append(layers, v)
	}
	return layers, nil
}

// Fact is one current entry of a memory layer, its body once read.
type Fact struct {
	Vault store.KnowledgeVault
	Entry store.KnowledgeEntry
	Body  string
}

// Facts are the current (active, unexpired) entries of agent's layers whose
// title holds query (any case), newest first; metadata only (ReadBodies).
func (s *Service) Facts(ctx context.Context, agent store.PersonalAgent, query string) ([]Fact, error) {
	layers, err := s.MemoryLayers(ctx, agent)
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	facts := []Fact{}
	for _, v := range layers {
		if v.State != "active" {
			continue
		}
		entries, err := s.store.ListKnowledgeEntries(ctx, v.UserID, v.ID)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entryCurrent(entry, v.Epoch) && strings.Contains(strings.ToLower(entry.Title), needle) {
				facts = append(facts, Fact{Vault: v, Entry: entry})
			}
		}
	}
	slices.SortStableFunc(facts, func(a, b Fact) int {
		if c := strings.Compare(b.Entry.UpdatedAt, a.Entry.UpdatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.Entry.ID, b.Entry.ID)
	})
	return facts, nil
}

// ReadBodies reads facts' bodies from their devices in order until budget
// runes are read (0: no budget) or the time runs out; a fact left unread
// keeps an empty Body.
func (s *Service) ReadBodies(ctx context.Context, facts []Fact, budget int, within time.Duration) {
	ctx, cancel := context.WithTimeout(ctx, within)
	defer cancel()
	used := 0
	for i := range facts {
		if ctx.Err() != nil || (budget > 0 && used >= budget) {
			return
		}
		doc, err := s.ReadEntry(ctx, facts[i].Vault, facts[i].Entry.ID, false)
		if err != nil || doc == nil {
			continue
		}
		facts[i].Body = doc.Body
		used += len([]rune(doc.Body))
	}
}

// Move is moving one entry to agent's other layer.
type Move struct {
	ToScope          string `json:"toScope"`
	ExpectedRevision int64  `json:"expectedRevision"`
	ExpectedHash     string `json:"expectedHash"`
}

// MoveEntry moves entryID of agent's other layer into its layer
// input.ToScope (created if needed): the current body is written there as a
// new entry, then the source is forgotten. A replay answers the first move.
func (s *Service) MoveEntry(ctx context.Context, agent store.PersonalAgent, entryID string, input Move) (store.MemoryEntryMove, error) {
	if !ValidMemoryScope(input.ToScope) {
		return store.MemoryEntryMove{}, invalid("toScope must be person or assistant")
	}
	fromScope := store.MemoryScopePerson
	if input.ToScope == store.MemoryScopePerson {
		fromScope = store.MemoryScopeAssistant
	}
	from, err := s.MemoryLayer(ctx, agent, fromScope)
	if err != nil {
		return store.MemoryEntryMove{}, err
	}
	if _, err = s.Workspace(ctx, agent.UserID, from); err != nil {
		return store.MemoryEntryMove{}, err
	}
	revision := strconv.FormatInt(input.ExpectedRevision, 10)
	request := flow.Key("kmove", from.ID, entryID, revision)
	forgetID := flow.Key("kmove-forget", from.ID, entryID, revision)
	result := store.MemoryEntryMove{FromScope: store.MemoryLayerScope(fromScope), ToScope: store.MemoryLayerScope(input.ToScope), SourceEntryID: entryID, Status: "captured"}
	if _, err = s.store.GetKnowledgeMutation(ctx, agent.UserID, forgetID); err == nil {
		to, err := s.MemoryLayer(ctx, agent, input.ToScope)
		if err != nil {
			return store.MemoryEntryMove{}, err
		}
		result.TargetVaultID, result.TargetEntryID = to.ID, flow.Key("knowledge", to.ID, request)
		return result, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.MemoryEntryMove{}, err
	}
	entry, err := s.store.GetKnowledgeEntry(ctx, agent.UserID, from.ID, entryID)
	if err != nil {
		return store.MemoryEntryMove{}, err
	}
	if entry.Revision != input.ExpectedRevision || entry.Hash != input.ExpectedHash {
		return store.MemoryEntryMove{}, &personalagent.Refusal{Status: http.StatusConflict, Err: errors.New("the entry changed; read its current revision and hash before moving it")}
	}
	doc, err := s.ReadEntry(ctx, from, entryID, true)
	if err != nil {
		return store.MemoryEntryMove{}, err
	}
	to, err := s.EnsureMemoryLayer(ctx, agent, input.ToScope)
	if err != nil {
		return store.MemoryEntryMove{}, err
	}
	// A new source reference: forgetting the source revokes its own
	// reference, which must not refuse (or, on index repair, hide) the copy.
	sourceRef := "memory-move:" + entryID + "@" + revision + ";" + entry.SourceRef
	if len(sourceRef) > 2000 {
		sourceRef = sourceRef[:2000]
	}
	write, err := s.Write(ctx, to, WriteRequest{RequestID: request, Title: entry.Title, Body: doc.Body, SourceRef: sourceRef, SourceVersion: entry.SourceVersion, ExpiresAt: entry.ExpiresAt})
	if err != nil {
		return store.MemoryEntryMove{}, err
	}
	if _, err = s.store.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: forgetID, UserID: agent.UserID, VaultID: from.ID, EntryID: entryID, Epoch: from.Epoch, Action: "forget", ExpectedRevision: entry.Revision, ExpectedHash: entry.Hash, RequestHash: forgetID}); err != nil {
		return store.MemoryEntryMove{}, err
	}
	result.TargetVaultID, result.TargetEntryID = to.ID, write.EntryID
	return result, nil
}

// legacyLayerRetry spaces creating a person's layer for their legacy facts
// when it failed (an offline device), per person.
const legacyLayerRetry = 10 * time.Minute

var legacyLayerTried sync.Map // user id -> time.Time

// drainLegacyMemory copies each confirmed legacy fact (pa_memory) once into
// its person's layer, creating the layer when they have none. The legacy
// rows stay, read-only, for rollback.
func (s *Service) drainLegacyMemory(ctx context.Context) {
	items, err := s.store.LegacyMemoryToCopy(ctx, 500)
	if err != nil {
		log.Printf("legacy memory drain user=- assistant=-: %v; retrying at next knowledge drain", err)
		return
	}
	layers := map[string]string{}
	for _, item := range items {
		if ctx.Err() != nil {
			return
		}
		vaultID, known := layers[item.UserID]
		if !known {
			vaultID = s.legacyLayer(ctx, item.UserID)
			layers[item.UserID] = vaultID
		}
		if vaultID != "" {
			if _, err := s.store.CopyLegacyMemory(ctx, item, vaultID); err != nil {
				assistantID := item.AssistantID
				if assistantID == "" {
					assistantID = "unknown"
				}
				log.Printf("legacy memory copy user=%s assistant=%s: %v; retrying at next knowledge drain", item.UserID, assistantID, err)
			}
		}
	}
}

func (s *Service) legacyLayer(ctx context.Context, user string) string {
	id := MemoryLayerID(user, "")
	if _, err := s.store.GetKnowledgeVault(ctx, user, id); err == nil {
		return id
	} else if !errors.Is(err, store.ErrNotFound) {
		s.logLegacyLayerFailure(ctx, user, "", err, "next knowledge drain")
		return ""
	}
	if at, ok := legacyLayerTried.Load(user); ok && time.Since(at.(time.Time)) < legacyLayerRetry {
		return ""
	}
	retryAt := time.Now().Add(legacyLayerRetry)
	legacyLayerTried.Store(user, time.Now())
	agent, err := s.store.DefaultAssistant(ctx, user)
	if err != nil {
		s.logLegacyLayerFailure(ctx, user, "", err, retryAt.UTC().Format(time.RFC3339))
		return ""
	}
	v, err := s.EnsureMemoryLayer(ctx, agent, store.MemoryScopePerson)
	if err != nil {
		s.logLegacyLayerFailure(ctx, user, agent.ID, err, retryAt.UTC().Format(time.RFC3339))
		return ""
	}
	return v.ID
}

func (s *Service) logLegacyLayerFailure(ctx context.Context, user, assistantID string, cause error, retry string) {
	if assistantID == "" {
		if agent, err := s.store.DefaultAssistant(ctx, user); err == nil {
			assistantID = agent.ID
		}
	}
	if assistantID == "" {
		assistantID = "unknown"
	}
	log.Printf("legacy memory layer user=%s assistant=%s: %v; retrying at %s", user, assistantID, cause, retry)
}
