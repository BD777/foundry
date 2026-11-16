package httpapi

import (
	"context"
	"log"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// Project upkeep as Needs you items (DEV-256): one open item per person and
// project whose reviews suggest file changes the person has not decided. Its
// episode is the newest review that still holds an undecided suggestion, so
// a new review opens a new item once the old one closed. Applying or
// dismissing every suggestion closes it. Like the unprocessed-message items
// it is reconciled when the person's list is read.

// upkeepPendingKey is scoped to the person: a project is shared by its
// members, and an item key is not otherwise scoped by person.
func upkeepPendingKey(userID, workspaceID string) string {
	return "upkeep:" + userID + ":" + workspaceID
}

// upkeepSettledAt reports whether one suggested change is decided: its newest
// file change is applying or applied. A conflict or a preview leaves it
// undecided, so the person still has to answer it (DEV-256).
func upkeepSettledAt(job store.PersonalAgentMaintenance, patches []store.PersonalAgentContextPatch, index int) bool {
	for _, patch := range patches {
		if patch.JobID == job.ID && patch.Index == index {
			return patch.Status == "applying" || patch.Status == "applied"
		}
	}
	return false
}

// upkeepUndecided counts one review's suggested changes the person has not
// decided. patches are newest first, as the store lists them.
func upkeepUndecided(job store.PersonalAgentMaintenance, patches []store.PersonalAgentContextPatch) int {
	if job.Status != "review" || job.Result == nil {
		return 0
	}
	undecided := 0
	for index := range job.Result.Patches {
		if !upkeepSettledAt(job, patches, index) {
			undecided++
		}
	}
	return undecided
}

// upkeepFirstReason is why the review's first undecided change is suggested.
func upkeepFirstReason(job store.PersonalAgentMaintenance, patches []store.PersonalAgentContextPatch) string {
	for index, patch := range job.Result.Patches {
		if !upkeepSettledAt(job, patches, index) {
			return patch.Reason
		}
	}
	return ""
}

// upkeepOpenKeys is the open project-upkeep item keys in a listed set.
func upkeepOpenKeys(items []store.PendingItem) map[string]bool {
	return pendingOpenKeysOf(items, store.PendingSourceProjectUpkeep)
}

// pendingOpenKeysOf is the open item keys of one source in a listed set: what
// a reconcile on read compares its own items against.
func pendingOpenKeysOf(items []store.PendingItem, source string) map[string]bool {
	keys := map[string]bool{}
	for _, item := range items {
		if item.Source == source && item.State == store.PendingOpen {
			keys[item.Key] = true
		}
	}
	return keys
}

// reconcileUpkeepPending brings the person's project-upkeep items up to what
// their projects' reviews hold now. openKeys is the open items the caller
// listed: a project that no longer holds an undecided suggestion closes its
// item, and a project the person no longer owns or has archived closes too.
// It reports whether anything changed.
func (s *Server) reconcileUpkeepPending(ctx context.Context, userID string, openKeys map[string]bool) bool {
	roles, err := s.store.WorkspaceRolesForUser(ctx, userID)
	if err != nil {
		return false
	}
	reviews, err := s.store.ListReviewingWorkspaceMaintenance(ctx, userID)
	if err != nil {
		return false
	}
	reviewsByWorkspace := map[string][]store.PersonalAgentMaintenance{}
	var workspaces []string
	for _, review := range reviews {
		if _, seen := reviewsByWorkspace[review.WorkspaceID]; !seen {
			workspaces = append(workspaces, review.WorkspaceID)
		}
		reviewsByWorkspace[review.WorkspaceID] = append(reviewsByWorkspace[review.WorkspaceID], review)
	}
	changed := false
	waiting := map[string]bool{}
	for _, workspaceID := range workspaces {
		if roles[workspaceID] != store.WorkspaceRoleOwner {
			continue
		}
		workspace, err := s.store.GetWorkspace(ctx, workspaceID)
		if err != nil || workspace.ArchivedAt != "" {
			continue
		}
		patches, err := s.store.ListPersonalAgentContextPatchesForWorkspace(ctx, userID, workspaceID)
		if err != nil {
			log.Printf("upkeep pending %s: read file changes: %v", workspaceID, err)
			continue
		}
		undecided, episode, reason := 0, "", ""
		for _, review := range reviewsByWorkspace[workspaceID] {
			count := upkeepUndecided(review, patches)
			if count == 0 {
				continue
			}
			if episode == "" {
				episode, reason = review.ID, upkeepFirstReason(review, patches)
			}
			undecided += count
		}
		if undecided == 0 {
			continue
		}
		key := upkeepPendingKey(userID, workspaceID)
		title := workspace.Name
		if title == "" {
			title = workspaceID
		}
		waiting[key] = true
		item := store.PendingItem{
			UserID: userID, WorkspaceID: workspaceID, Source: store.PendingSourceProjectUpkeep,
			Key: key, EventID: key + ":" + episode, Title: title, Count: undecided,
			Excerpt: textcut.Excerpt(reason, pendingExcerptLimit),
		}
		_, recorded, err := s.store.RecordPendingItem(ctx, item)
		if err != nil {
			log.Printf("upkeep pending %s: record item: %v", workspaceID, err)
			continue
		}
		changed = changed || recorded
	}
	for key := range openKeys {
		if waiting[key] {
			continue
		}
		// Every suggestion was decided on the project's page (or the project
		// left the person's hands): the item closes for that reason.
		resolved, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{
			Key: key, Sources: []string{store.PendingSourceProjectUpkeep}, State: store.PendingDone,
			ResolutionReason: store.PendingResolutionAutoResolved, ResolutionDetail: "decided",
		})
		if err != nil {
			log.Printf("upkeep pending %s: close item: %v", key, err)
			continue
		}
		changed = changed || resolved > 0
	}
	return changed
}
