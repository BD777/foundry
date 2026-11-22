package httpapi

import (
	"context"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A Needs you entry is stuck on the item its session works on (DEV-324's
// ledger), found only from what Foundry recorded: a helper is tied to its item
// (the assistant's task on it, or a helper linked to it), and a session that
// holds exactly one open item is that item's. A session that holds several
// names none of them. Nothing reads the entry's words to decide.

// pendingItemLink is the open item a session's entries are stuck on.
type pendingItemLink struct {
	AssistantID string
	ItemID      string
	Text        string
}

// openItemsBySession maps each session tied to one of the person's open items
// to that item: its helpers first, then a holder of only that item.
func (s *Server) openItemsBySession(ctx context.Context, userID string) (map[string]pendingItemLink, error) {
	links := map[string]pendingItemLink{}
	held := map[string][]pendingItemLink{}
	filter := store.PersonalAgentItemFilter{UserID: userID, View: store.PersonalAgentItemViewOpen, Limit: store.PersonalAgentItemPageMax}
	for {
		page, err := s.store.ListPersonalAgentItemPage(ctx, "", filter)
		if err != nil {
			return nil, fmt.Errorf("list open items: %w", err)
		}
		for _, item := range page.Items {
			link := pendingItemLink{AssistantID: item.AssistantID, ItemID: item.ID, Text: item.Text}
			for _, helper := range page.Helpers[item.ID] {
				if _, seen := links[helper.SessionID]; helper.SessionID != "" && !seen {
					links[helper.SessionID] = link
				}
			}
			if item.HolderSessionID != "" {
				held[item.HolderSessionID] = append(held[item.HolderSessionID], link)
			}
		}
		if page.NextOffset == 0 {
			break
		}
		filter.Offset = page.NextOffset
	}
	for sessionID, items := range held {
		if _, seen := links[sessionID]; !seen && len(items) == 1 {
			links[sessionID] = items[0]
		}
	}
	return links, nil
}

// waitsOnPerson is a request the person has to act on now: open and theirs to
// handle, not their assistant's, and not a note that asks for nothing. Every
// count of Needs you counts these.
func waitsOnPerson(item store.PendingItem) bool {
	return item.State == store.PendingOpen && store.PendingHandledBy(item) == store.PendingHandlerPerson &&
		item.Source != store.PendingSourceNotice
}

// needsYouByItem is what waits on the person for each of their open items, by
// item id, newest first: the visible entries Needs you lists and counts.
func (s *Server) needsYouByItem(ctx context.Context, userID string) (map[string][]store.PersonalAgentItemNeedsYou, error) {
	pending, err := s.store.ListVisiblePendingItems(ctx, userID, []string{store.PendingOpen}, "", 500)
	if err != nil {
		return nil, fmt.Errorf("list pending items: %w", err)
	}
	byItem := map[string][]store.PersonalAgentItemNeedsYou{}
	if len(pending) == 0 {
		return byItem, nil
	}
	links, err := s.openItemsBySession(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, item := range pending {
		link, linked := links[item.SessionID]
		if item.SessionID == "" || !linked || !waitsOnPerson(item) {
			continue
		}
		byItem[link.ItemID] = append(byItem[link.ItemID], store.PersonalAgentItemNeedsYou{
			ID: item.ID, Source: item.Source, Title: item.Title, SessionID: item.SessionID, CreatedAt: item.CreatedAt,
		})
	}
	return byItem, nil
}
