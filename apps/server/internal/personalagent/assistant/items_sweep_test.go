package assistant

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sweepStore answers the time rule's sweep and nothing else.
type sweepStore struct {
	Store
	archived []store.PersonalAgentArchivedItem
}

func (s sweepStore) SweepArchiveFinishedItems(context.Context, time.Time, time.Duration) ([]store.PersonalAgentArchivedItem, error) {
	return s.archived, nil
}

// The sweep archives the ended helper sessions of each item it archives,
// through the port, and a session the port cannot archive is reported with
// its item while the other items still go.
func TestItemSweepArchivesHelperSessionsAndReportsFailures(t *testing.T) {
	swept := sweepStore{archived: []store.PersonalAgentArchivedItem{
		{AssistantID: "asst_a", ItemID: "item_a", SessionIDs: []string{"sess_a"}},
		{AssistantID: "asst_a", ItemID: "item_b", SessionIDs: []string{"sess_blocked"}},
		{AssistantID: "asst_a", ItemID: "item_none"},
		{AssistantID: "asst_a", ItemID: "item_c", SessionIDs: []string{"sess_c"}},
	}}
	var archivedFor []string
	service := &Service{store: swept, archiveItemSessions: func(_ context.Context, _, assistantID, _ string, sessionIDs []string) error {
		archivedFor = append(archivedFor, strings.Join(sessionIDs, ","))
		if slices.Contains(sessionIDs, "sess_blocked") {
			return errors.New("session sess_blocked: the archive refused it")
		}
		return nil
	}}

	err := service.archiveFinishedItems(context.Background(), time.Now())
	if strings.Join(archivedFor, " ") != "sess_a sess_blocked sess_c" {
		t.Fatalf("port calls = %v; an item with no helper sessions must not call it", archivedFor)
	}
	if err == nil || !strings.Contains(err.Error(), "item item_b") || !strings.Contains(err.Error(), "the archive refused it") {
		t.Fatalf("the failing session is not reported with its item: %v", err)
	}
	if strings.Contains(err.Error(), "item item_a") || strings.Contains(err.Error(), "item item_c") {
		t.Fatalf("a session that archived is reported as failed: %v", err)
	}
}

// Without a port the sweep cannot archive the sessions: it reports that
// instead of leaving them behind silently.
func TestItemSweepWithoutPortReportsTheSessions(t *testing.T) {
	service := &Service{store: sweepStore{archived: []store.PersonalAgentArchivedItem{
		{AssistantID: "asst_a", ItemID: "item_a", SessionIDs: []string{"sess_a"}},
	}}}
	if err := service.archiveFinishedItems(context.Background(), time.Now()); err == nil || !strings.Contains(err.Error(), "item_a") {
		t.Fatalf("no port: %v", err)
	}
}
