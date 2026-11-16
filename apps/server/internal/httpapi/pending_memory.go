package httpapi

import (
	"context"
	"log"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// Memory upkeep as Needs you items (DEV-256): one open item per person and
// assistant whose memory reviews, in either layer, hold findings the person
// has not dismissed. The item counts those findings; its episode is the newest
// review. Dismissing every such review closes it. Reconciled on read, as the
// project-upkeep items are.

// memoryUpkeepPendingKey is scoped to the person, as the project keys are.
func memoryUpkeepPendingKey(userID, assistantID string) string {
	return "memory_upkeep:" + userID + ":" + assistantID
}

// reconcileMemoryPending brings the person's memory-upkeep items up to what
// their memory reviews hold now. openKeys is the open items the caller listed:
// an assistant with no review left to decide closes its item. It reports
// whether anything changed.
func (s *Server) reconcileMemoryPending(ctx context.Context, userID string, openKeys map[string]bool) bool {
	reviews, err := s.store.ListReviewingMemoryMaintenance(ctx, userID)
	if err != nil {
		return false
	}
	// Reviews arrive newest first, so each assistant's first review is its episode.
	reviewsByAssistant := map[string][]store.PersonalAgentMaintenance{}
	var assistants []string
	for _, review := range reviews {
		if review.Result == nil || len(review.Result.Findings) == 0 {
			continue
		}
		if _, seen := reviewsByAssistant[review.AssistantID]; !seen {
			assistants = append(assistants, review.AssistantID)
		}
		reviewsByAssistant[review.AssistantID] = append(reviewsByAssistant[review.AssistantID], review)
	}
	changed := false
	waiting := map[string]bool{}
	for _, assistantID := range assistants {
		agent, err := s.store.GetAssistant(ctx, assistantID)
		if err != nil || agent.UserID != userID || agent.WorkspaceID == "" {
			continue
		}
		undecided := 0
		newest := reviewsByAssistant[assistantID][0]
		for _, review := range reviewsByAssistant[assistantID] {
			undecided += len(review.Result.Findings)
		}
		key := memoryUpkeepPendingKey(userID, assistantID)
		title := agent.Name
		if title == "" {
			title = assistantID
		}
		waiting[key] = true
		item := store.PendingItem{
			UserID: userID, AssistantID: assistantID, WorkspaceID: agent.WorkspaceID,
			Source: store.PendingSourceMemoryUpkeep, Key: key, EventID: key + ":" + newest.ID,
			Title: title, Count: undecided,
			Excerpt: textcut.Excerpt(newest.Result.Findings[0].Summary, pendingExcerptLimit),
		}
		_, recorded, err := s.store.RecordPendingItem(ctx, item)
		if err != nil {
			log.Printf("memory upkeep pending %s: record item: %v", assistantID, err)
			continue
		}
		changed = changed || recorded
	}
	for key := range openKeys {
		if waiting[key] {
			continue
		}
		// Every memory review was dismissed (or the assistant left the
		// person's hands): the item closes for that reason.
		resolved, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{
			Key: key, Sources: []string{store.PendingSourceMemoryUpkeep}, State: store.PendingDone,
			ResolutionReason: store.PendingResolutionAutoResolved, ResolutionDetail: "decided",
		})
		if err != nil {
			log.Printf("memory upkeep pending %s: close item: %v", key, err)
			continue
		}
		changed = changed || resolved > 0
	}
	return changed
}
