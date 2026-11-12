package knowledge

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/redact"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Sorting between the person's layer and their assistants' (DEV-191). The
// memory review judges each entry (Placement); the code here decides and
// executes:
//   - person's layer → its source assistant's layer whenever the entry is
//     about a domain (belongs assistant) or mentions anyone or anything;
//   - an assistant's layer → the person's only when it is about the person,
//     mentions nothing and the judgement is high-confidence; otherwise, if
//     about the person, a suggestion for the person to confirm or dismiss.
// An entry with mentions never enters the person's layer automatically. An
// entry already moved once (by a sort, an undo or the person) is not sorted
// again: its placement stands. Every automatic move is logged and can be
// undone; a move reuses MoveEntry (write the target, then forget the
// source).

// Placement is the memory review's judgement of one entry.
type Placement struct {
	EntryID    string   `json:"entryId"`
	Belongs    string   `json:"belongs"`
	Confidence string   `json:"confidence"`
	Reason     string   `json:"reason"`
	Mentions   []string `json:"mentions"`
}

// Placement judgements.
const (
	BelongsPerson    = "person"
	BelongsAssistant = "assistant"
	ConfidenceHigh   = "high"
)

// movedSourcePrefix starts the source reference of an entry MoveEntry wrote.
const movedSourcePrefix = "memory-move:"

const (
	sortReasonRunes  = 300
	sortMentionRunes = 80
	sortMentionsMax  = 8
	sortListLimit    = 100
	// sortReplayAfter spaces replays of a move left in flight.
	sortReplayAfter = time.Minute
)

// MemorySortID is the record of sorting entryID of vaultID: one per entry.
func MemorySortID(vaultID, entryID string) string {
	return flow.Key("msort", vaultID, entryID)
}

// SortLayer applies the review of v (a memory layer reviewed as reviewer
// under job jobID). It is idempotent: an entry's record is found again and
// a move still in flight is replayed.
func (s *Service) SortLayer(ctx context.Context, reviewer store.PersonalAgent, v store.KnowledgeVault, jobID string, placements []Placement) error {
	if v.Kind != "memory" || v.UserID != reviewer.UserID || len(placements) == 0 {
		return nil
	}
	if v.Scope == store.MemoryScopeAssistant && v.AssistantID != reviewer.ID {
		return invalid("another assistant's memory layer")
	}
	entries, err := s.store.ListKnowledgeEntries(ctx, v.UserID, v.ID)
	if err != nil {
		return err
	}
	byID := map[string]store.KnowledgeEntry{}
	for _, entry := range entries {
		byID[entry.ID] = entry
	}
	seen := map[string]bool{}
	var failed error
	for _, p := range placements {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		entry, known := byID[p.EntryID]
		if !known || seen[p.EntryID] {
			continue
		}
		seen[p.EntryID] = true
		id := MemorySortID(v.ID, entry.ID)
		existing, err := s.store.GetMemorySort(ctx, v.UserID, id)
		if err == nil {
			if existing.Status == store.MemorySortMoving {
				if _, err := s.finishMove(ctx, existing); err != nil {
					failed = err
				}
				continue
			}
			if existing.Status != store.MemorySortFailed {
				continue
			}
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if !entryCurrent(entry, v.Epoch) || strings.HasPrefix(entry.SourceRef, movedSourcePrefix) {
			continue
		}
		record := store.MemorySort{
			ID: id, UserID: v.UserID, JobID: jobID, Reason: cleanSortText(p.Reason, sortReasonRunes),
			SourceVaultID: v.ID, SourceEntryID: entry.ID, SourceRevision: entry.Revision, SourceHash: entry.Hash,
			Title: entry.Title, Judgement: p.Belongs, Confidence: p.Confidence, Mentions: cleanMentions(p.Mentions),
		}
		switch v.Scope {
		case store.MemoryScopePerson:
			if p.Belongs != BelongsAssistant && len(record.Mentions) == 0 {
				continue
			}
			owner := s.sourceAssistant(ctx, v.UserID, entry)
			if owner.ID == "" {
				continue
			}
			record.AssistantID, record.Kind = owner.ID, store.MemorySortMove
			record.FromScope, record.ToScope = store.MemoryScopePerson, store.MemoryScopeAssistant
		case store.MemoryScopeAssistant:
			if p.Belongs != BelongsPerson || len(record.Mentions) > 0 {
				continue
			}
			record.AssistantID = reviewer.ID
			record.FromScope, record.ToScope = store.MemoryScopeAssistant, store.MemoryScopePerson
			record.Kind = store.MemorySortSuggestion
			if p.Confidence == ConfidenceHigh {
				record.Kind = store.MemorySortMove
			}
		default:
			continue
		}
		if err := s.sortEntry(ctx, record, existing); err != nil {
			failed = err
		}
	}
	return failed
}

// sortEntry records a new decision (or retries existing, a failed move)
// and, for a move, executes it.
func (s *Service) sortEntry(ctx context.Context, record store.MemorySort, existing store.MemorySort) error {
	if record.Kind == store.MemorySortSuggestion {
		if existing.ID != "" {
			return nil
		}
		record.Status = store.MemorySortSuggested
		_, _, err := s.store.RecordMemorySort(ctx, record)
		return err
	}
	record.Status = store.MemorySortMoving
	var err error
	if existing.ID != "" {
		record.CreatedAt = existing.CreatedAt
		record, err = s.store.UpdateMemorySort(ctx, record, existing.Status)
	} else {
		record, _, err = s.store.RecordMemorySort(ctx, record)
	}
	if err != nil {
		return err
	}
	if record.Status != store.MemorySortMoving {
		return nil
	}
	_, err = s.finishMove(ctx, record)
	return err
}

// drainMemorySorts replays the moves a failure left in flight (a device or
// the database was unavailable); MoveEntry answers a captured move again.
func (s *Service) drainMemorySorts(ctx context.Context) {
	records, err := s.store.MovingMemorySorts(ctx, 50)
	if err != nil {
		return
	}
	for _, record := range records {
		if ctx.Err() != nil {
			return
		}
		if at, err := time.Parse(time.RFC3339Nano, record.UpdatedAt); err == nil && time.Since(at) < sortReplayAfter {
			continue
		}
		_, _ = s.finishMove(ctx, record)
	}
}

// finishMove executes (or replays) a record's move and records the outcome.
func (s *Service) finishMove(ctx context.Context, record store.MemorySort) (store.MemorySort, error) {
	from := record.Status
	agent, err := s.sortAssistant(ctx, record)
	var move store.MemoryEntryMove
	if err == nil {
		move, err = s.MoveEntry(ctx, agent, record.SourceEntryID, Move{ToScope: record.ToScope, ExpectedRevision: record.SourceRevision, ExpectedHash: record.SourceHash})
	}
	if err != nil {
		record.Failure = cleanSortText(err.Error(), sortReasonRunes)
		var refusal *personalagent.Refusal
		if errors.As(err, &refusal) || errors.Is(err, store.ErrNotFound) {
			record.Status = store.MemorySortFailed
		}
		// Otherwise transient (a device, the database): it stays moving and
		// drainMemorySorts replays it after sortReplayAfter.
		if _, e := s.store.UpdateMemorySort(ctx, record, from); e != nil {
			return record, e
		}
		return record, err
	}
	record.Status, record.Failure = store.MemorySortMoved, ""
	record.TargetVaultID, record.TargetEntryID = move.TargetVaultID, move.TargetEntryID
	return s.store.UpdateMemorySort(ctx, record, from)
}

func (s *Service) sortAssistant(ctx context.Context, record store.MemorySort) (store.PersonalAgent, error) {
	agent, err := s.store.GetAssistant(ctx, record.AssistantID)
	if err != nil {
		return store.PersonalAgent{}, err
	}
	if agent.UserID != record.UserID {
		return store.PersonalAgent{}, store.ErrNotFound
	}
	return agent, nil
}

// sourceAssistant is the assistant that wrote entry into the person's
// layer, from its source reference: the session's assistant, or a legacy
// fact's; the default assistant when it cannot be told (entries from before
// DEV-191 P2 and the person's own).
func (s *Service) sourceAssistant(ctx context.Context, user string, entry store.KnowledgeEntry) store.PersonalAgent {
	ref := entry.SourceRef
	candidate := ""
	switch {
	case strings.HasPrefix(ref, "session:"):
		session, _, _ := strings.Cut(strings.TrimPrefix(ref, "session:"), "/")
		if agent, err := s.store.AssistantForSession(ctx, session); err == nil {
			candidate = agent.ID
		}
	case strings.HasPrefix(ref, "legacy-memory:"):
		if item, err := s.store.GetPersonalAgentMemory(ctx, user, strings.TrimPrefix(ref, "legacy-memory:")); err == nil {
			candidate = item.AssistantID
		}
	}
	if candidate != "" {
		if agent, err := s.store.GetAssistant(ctx, candidate); err == nil && agent.UserID == user {
			return agent
		}
	}
	agent, err := s.store.DefaultAssistant(ctx, user)
	if err != nil {
		return store.PersonalAgent{}
	}
	return agent
}

func cleanSortText(value string, limit int) string {
	value = strings.Join(strings.Fields(redact.Text(value)), " ")
	if runes := []rune(value); len(runes) > limit {
		value = string(runes[:limit])
	}
	return value
}

func cleanMentions(values []string) []string {
	out := []string{}
	for _, value := range values {
		if value = cleanSortText(value, sortMentionRunes); value != "" && len(out) < sortMentionsMax {
			out = append(out, value)
		}
	}
	return out
}

// SortView is a record as the person's settings show it: whether a move can
// be undone now and whether a suggestion still stands.
type SortView struct {
	store.MemorySort
	Undoable bool
	Current  bool
}

// SortRecords are user's recent moves and their standing suggestions,
// newest first.
func (s *Service) SortRecords(ctx context.Context, user string) (moves, suggestions []SortView, err error) {
	records, err := s.store.ListMemorySorts(ctx, user, sortListLimit)
	if err != nil {
		return nil, nil, err
	}
	moves, suggestions = []SortView{}, []SortView{}
	for _, record := range records {
		switch record.Kind {
		case store.MemorySortMove:
			view := SortView{MemorySort: record}
			if record.Status == store.MemorySortMoved {
				_, view.Undoable = s.undoTarget(ctx, record)
			}
			moves = append(moves, view)
		case store.MemorySortSuggestion:
			if record.Status != store.MemorySortSuggested {
				continue
			}
			entry, err := s.store.GetKnowledgeEntry(ctx, user, record.SourceVaultID, record.SourceEntryID)
			if err != nil || entry.State != "active" || entry.Revision != record.SourceRevision || entry.Hash != record.SourceHash {
				continue
			}
			suggestions = append(suggestions, SortView{MemorySort: record, Current: true})
		}
	}
	return moves, suggestions, nil
}

// undoTarget is the moved entry an undo moves back, when it is in place.
func (s *Service) undoTarget(ctx context.Context, record store.MemorySort) (store.KnowledgeEntry, bool) {
	if record.TargetVaultID == "" || record.TargetEntryID == "" {
		return store.KnowledgeEntry{}, false
	}
	entry, err := s.store.GetKnowledgeEntry(ctx, record.UserID, record.TargetVaultID, record.TargetEntryID)
	if err != nil || entry.State != "active" {
		return store.KnowledgeEntry{}, false
	}
	return entry, true
}

func sortConflict(message string) error {
	return &personalagent.Refusal{Status: http.StatusConflict, Err: errors.New(message)}
}

// SortAction is the person undoing an automatic move ("undo"), or
// confirming ("confirm") or dismissing ("dismiss") a suggestion to share.
func (s *Service) SortAction(ctx context.Context, user, id, action string) (store.MemorySort, error) {
	record, err := s.store.GetMemorySort(ctx, user, id)
	if err != nil {
		return store.MemorySort{}, err
	}
	switch action {
	case "undo":
		if record.Kind != store.MemorySortMove || record.Status != store.MemorySortMoved {
			return store.MemorySort{}, sortConflict("only a completed automatic move can be undone")
		}
		target, ok := s.undoTarget(ctx, record)
		if !ok {
			return store.MemorySort{}, sortConflict("the moved entry is not in place yet, or was changed or forgotten since")
		}
		agent, err := s.sortAssistant(ctx, record)
		if err != nil {
			return store.MemorySort{}, err
		}
		if _, err = s.MoveEntry(ctx, agent, target.ID, Move{ToScope: record.FromScope, ExpectedRevision: target.Revision, ExpectedHash: target.Hash}); err != nil {
			return store.MemorySort{}, err
		}
		record.Status = store.MemorySortUndone
		return s.store.UpdateMemorySort(ctx, record, store.MemorySortMoved)
	case "confirm":
		if record.Kind != store.MemorySortSuggestion || record.Status != store.MemorySortSuggested {
			return store.MemorySort{}, sortConflict("only a standing suggestion can be confirmed")
		}
		if len(record.Mentions) > 0 || record.ToScope != store.MemoryScopePerson {
			return store.MemorySort{}, sortConflict("an entry that mentions people or projects stays in its assistant's layer")
		}
		agent, err := s.sortAssistant(ctx, record)
		if err != nil {
			return store.MemorySort{}, err
		}
		move, err := s.MoveEntry(ctx, agent, record.SourceEntryID, Move{ToScope: record.ToScope, ExpectedRevision: record.SourceRevision, ExpectedHash: record.SourceHash})
		if err != nil {
			return store.MemorySort{}, err
		}
		record.Status = store.MemorySortConfirmed
		record.TargetVaultID, record.TargetEntryID = move.TargetVaultID, move.TargetEntryID
		return s.store.UpdateMemorySort(ctx, record, store.MemorySortSuggested)
	case "dismiss":
		if record.Kind != store.MemorySortSuggestion || record.Status != store.MemorySortSuggested {
			return store.MemorySort{}, sortConflict("only a standing suggestion can be dismissed")
		}
		record.Status = store.MemorySortDismissed
		return s.store.UpdateMemorySort(ctx, record, store.MemorySortSuggested)
	}
	return store.MemorySort{}, invalid("action must be undo, confirm or dismiss")
}
