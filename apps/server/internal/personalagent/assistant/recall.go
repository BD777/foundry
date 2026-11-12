package assistant

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// What the assistant reads when it needs it, rather than having it in every
// turn (docs/personal-agent.md §12): the person's memory beyond what the
// turn's context shows, and their computers with what each has.

// memoryPageMax bounds one page of read_memory.
const memoryPageMax = 50

// memoryReadWithin bounds the device reads of one page or one turn's
// memory.
const memoryReadWithin = 4 * time.Second

// recalledFact is one fact the assistant recalls: an entry of one of its
// memory layers, or a confirmed legacy fact not yet copied to the person's
// layer (Legacy).
type recalledFact struct {
	ID        string `json:"id"`
	Scope     string `json:"scope"`
	VaultID   string `json:"vaultId,omitempty"`
	Title     string `json:"title,omitempty"`
	Content   string `json:"content,omitempty"`
	Origin    string `json:"origin"`
	Revision  int64  `json:"revision,omitempty"`
	Hash      string `json:"hash,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	UpdatedAt string `json:"updatedAt"`
	Legacy    bool   `json:"legacy,omitempty"`

	fact *knowledge.Fact
}

// recall is what agent recalls of the person, newest first: the current
// entries of the person's layer and its own whose title holds query (any
// case), and the confirmed legacy facts (pa_memory) whose content holds it
// until each is copied to the person's layer. Bodies are not read yet
// (readFacts).
func (s *Service) recall(ctx context.Context, agent store.PersonalAgent, query string) ([]recalledFact, error) {
	facts, err := s.knowledge.Facts(ctx, agent, query)
	if err != nil {
		return nil, err
	}
	recalled := make([]recalledFact, 0, len(facts))
	for i := range facts {
		entry := facts[i].Entry
		recalled = append(recalled, recalledFact{
			ID: entry.ID, Scope: facts[i].Vault.Scope, VaultID: entry.VaultID, Title: entry.Title, Origin: store.PersonalAgentMemoryStated,
			Revision: entry.Revision, Hash: entry.Hash, ExpiresAt: entry.ExpiresAt, UpdatedAt: entry.UpdatedAt, fact: &facts[i],
		})
	}
	legacy, err := s.store.ListPersonalAgentMemory(ctx, agent.UserID)
	if err != nil {
		return nil, err
	}
	copies, err := s.store.LegacyMemoryCopies(ctx, agent.UserID)
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	for _, item := range legacy {
		// An old inferred record may be active for UI purposes, but is not a confirmed fact.
		if item.Status != store.PersonalAgentMemoryActive || (item.Origin != store.PersonalAgentMemoryStated && item.Origin != store.PersonalAgentMemoryEdited) {
			continue
		}
		if status := copies[item.ID]; status == "copied" || status == "complete" || !strings.Contains(strings.ToLower(item.Content), needle) {
			continue
		}
		recalled = append(recalled, recalledFact{ID: item.ID, Scope: store.MemoryScopePerson, Content: item.Content, Origin: item.Origin, UpdatedAt: item.UpdatedAt, Legacy: true})
	}
	slices.SortStableFunc(recalled, func(a, b recalledFact) int {
		return strings.Compare(b.UpdatedAt, a.UpdatedAt)
	})
	return recalled, nil
}

// readFacts reads the bodies of facts in order until budget runes (0: no
// budget); a body its device does not give in time stays its title.
func (s *Service) readFacts(ctx context.Context, facts []recalledFact, budget int) {
	pending := []knowledge.Fact{}
	for _, fact := range facts {
		if fact.fact != nil {
			pending = append(pending, *fact.fact)
		}
	}
	s.knowledge.ReadBodies(ctx, pending, budget, memoryReadWithin)
	bodies := map[string]string{}
	for _, fact := range pending {
		bodies[fact.Vault.ID+"/"+fact.Entry.ID] = fact.Body
	}
	for i := range facts {
		if facts[i].fact != nil {
			facts[i].Content = cmp.Or(bodies[facts[i].VaultID+"/"+facts[i].ID], facts[i].Title)
		}
	}
}

// turnMemory is the turn's memory (prompt.Input.Memory): the newest facts
// agent recalls, read up to the turn's budget.
func (s *Service) turnMemory(ctx context.Context, agent store.PersonalAgent) ([]store.PersonalAgentMemoryItem, error) {
	facts, err := s.recall(ctx, agent, "")
	if err != nil {
		return nil, err
	}
	s.readFacts(ctx, facts, personalagent.L0AboutMaxChars)
	items := make([]store.PersonalAgentMemoryItem, 0, len(facts))
	for _, fact := range facts {
		items = append(items, store.PersonalAgentMemoryItem{ID: fact.ID, Scope: fact.Scope, Content: fact.Content, Origin: fact.Origin, Status: store.PersonalAgentMemoryActive, UpdatedAt: fact.UpdatedAt})
	}
	return items, nil
}

// ReadMemory is read_memory: what the assistant recalls of the person
// (recall), newest first, the facts whose title (or legacy content) holds
// query when one is given; at most limit (memoryPageMax) from offset, each
// with its body.
func (s *Service) ReadMemory(ctx context.Context, scope Scope, query string, offset, limit int) (map[string]any, error) {
	items, err := s.recall(ctx, scope.Agent, query)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > memoryPageMax {
		limit = memoryPageMax
	}
	total := len(items)
	offset = min(max(offset, 0), total)
	page := items[offset:min(offset+limit, total)]
	s.readFacts(ctx, page, 0)
	answer := map[string]any{"total": total, "items": page}
	if next := offset + len(page); next < total {
		answer["nextOffset"] = next
	}
	return answer, nil
}

// ListComputers is list_computers (prompt.Computers): the person's
// computers, where the assistant may work or create projects, and the
// labels the person gave and the facts Foundry found.
func (s *Service) ListComputers(ctx context.Context, scope Scope) (string, error) {
	devices, err := s.digests.Devices(ctx, scope.Agent.UserID)
	if err != nil {
		return "", err
	}
	places, err := s.ownDevicePlacements(ctx, devices, time.Now())
	if err != nil {
		return "", err
	}
	return prompt.Computers(prompt.Input{
		Settings:     scope.Agent.Settings,
		HomeDeviceID: scope.Agent.HomeDeviceID,
		Devices:      devices,
		Places:       places,
	}), nil
}
