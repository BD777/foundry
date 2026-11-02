package assistant

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// What the assistant reads when it needs it, rather than having it in every
// turn (docs/personal-agent.md §12): the person's memory beyond what the
// turn's context shows, and their computers with what each has.

// memoryPageMax bounds one page of read_memory.
const memoryPageMax = 50

// ReadMemory is read_memory: the person's active memory, newest first, the
// items whose content holds query (any case) when one is given; at most
// limit (memoryPageMax) from offset.
func (s *Service) ReadMemory(ctx context.Context, scope Scope, query string, offset, limit int) (map[string]any, error) {
	all, err := s.store.ListPersonalAgentMemory(ctx, scope.Agent.UserID)
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	items := slices.DeleteFunc(all, func(item store.PersonalAgentMemoryItem) bool {
		return item.Status != store.PersonalAgentMemoryActive ||
			(needle != "" && !strings.Contains(strings.ToLower(item.Content), needle))
	})
	slices.SortStableFunc(items, func(a, b store.PersonalAgentMemoryItem) int {
		return strings.Compare(b.UpdatedAt, a.UpdatedAt)
	})
	if limit <= 0 || limit > memoryPageMax {
		limit = memoryPageMax
	}
	total := len(items)
	offset = min(max(offset, 0), total)
	page := items[offset:min(offset+limit, total)]
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
