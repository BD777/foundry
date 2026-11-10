package sessions

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// TurnInitiator is the session whose message started a session's current
// turn. The input records the common case. A merge of held inbox messages
// names its first sender as sentBySessionId; if an older record lacks that
// field, delivered_input_id finds the message that formed the turn. Empty
// means the person started the turn.
func (s *Service) TurnInitiator(ctx context.Context, session store.AgentSession) (string, error) {
	if sender := strings.TrimSpace(session.Input.SentBySessionID); sender != "" {
		return sender, nil
	}
	if session.Input.ID == "" {
		return "", nil
	}
	since := time.Now().Add(-24 * time.Hour)
	if started, err := time.Parse(time.RFC3339Nano, session.Input.At); err == nil {
		since = started.Add(-time.Hour)
	}
	items, err := s.store.SessionInboxItems(ctx, session.ID, since, 200)
	if err != nil {
		return "", err
	}
	var sender string
	var earliest time.Time
	for _, item := range items {
		if item.DeliveredAs != "turn" || item.DeliveredInputID != session.Input.ID || item.SenderSessionID == "" {
			continue
		}
		if sender == "" || item.CreatedAt.Before(earliest) {
			sender, earliest = item.SenderSessionID, item.CreatedAt
		}
	}
	return sender, nil
}

// maxWaitingChildLevels is the deepest sub-session edge counted for a
// parent. Foundry caps session nesting at four levels.
const maxWaitingChildLevels = 4

// WaitingChildCounts reports how many direct sub-sessions each parent is
// waiting on. A parent P waits on child C when C's current turn is queued,
// running, or blocked and P itself started that input: either the input's
// sentBySessionId is P, or an inbox message from P was delivered as C's
// current turn (the merged-inbox case).
//
// A person-started input, timer turn, or another session's message therefore
// does not count. A native wake-up does not replace C's input, so work that
// continues on P's input still counts.
//
// C also counts after its own turn ended when its current input came from P
// and C has such waiting children itself. The count recurses through at most
// four sub-session levels. Each query is batched by level, never by parent.
func (s *Service) WaitingChildCounts(ctx context.Context, parentIDs []string) (map[string]int, error) {
	type level struct {
		parents  []string
		children map[string][]store.OutstandingChildTurn
	}

	frontier := uniqueSortedStrings(parentIDs)
	levels := make([]level, 0, maxWaitingChildLevels)
	for depth := 1; depth <= maxWaitingChildLevels && len(frontier) > 0; depth++ {
		children, err := s.store.OutstandingChildTurns(ctx, frontier)
		if err != nil {
			return nil, err
		}
		current := level{parents: frontier, children: children}
		levels = append(levels, current)

		next := map[string]bool{}
		for _, parentID := range frontier {
			for _, child := range children[parentID] {
				if child.StartedByParent && !store.IsActiveSessionStatus(child.Status) && depth < maxWaitingChildLevels {
					next[child.SessionID] = true
				}
			}
		}
		frontier = sortedKeys(next)
	}

	waiting := make(map[string]bool, len(parentIDs))
	counts := make(map[string]int, len(parentIDs))
	for index := len(levels) - 1; index >= 0; index-- {
		current := levels[index]
		for _, parentID := range current.parents {
			count := 0
			for _, child := range current.children[parentID] {
				if child.StartedByParent && (store.IsActiveSessionStatus(child.Status) || waiting[child.SessionID]) {
					count++
				}
			}
			waiting[parentID] = count > 0
			if index == 0 {
				counts[parentID] = count
			}
		}
	}
	return counts, nil
}

func uniqueSortedStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if value != "" {
			seen[value] = true
		}
	}
	return sortedKeys(seen)
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
