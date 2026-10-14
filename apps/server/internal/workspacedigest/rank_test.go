package workspacedigest

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type routingFixture struct {
	Now        string                  `json:"now"`
	Workspaces []store.WorkspaceDigest `json:"workspaces"`
	Notes      map[string]string       `json:"notes"`
	Cases      []struct {
		Request string `json:"request"`
		Gold    string `json:"gold"`
	} `json:"cases"`
}

func loadRoutingFixture(t *testing.T, path string) routingFixture {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture routingFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

// §13: on clear requests the right project comes first at least 90% of
// the time.
func TestRankPutsTheRightProjectFirstOnTheFixture(t *testing.T) {
	fixture := loadRoutingFixture(t, "testdata/routing.json")
	now, _ := time.Parse(time.RFC3339, fixture.Now)
	hits := 0
	for _, c := range fixture.Cases {
		candidates := Rank(c.Request, fixture.Workspaces, fixture.Notes, now, 3)
		got := ""
		if len(candidates) > 0 {
			got = candidates[0].WorkspaceID
		}
		if got == c.Gold {
			hits++
			continue
		}
		t.Logf("miss: %q → %s, want %s (%+v)", c.Request, got, c.Gold, candidates)
	}
	accuracy := float64(hits) / float64(len(fixture.Cases))
	t.Logf("top-1 %d/%d = %.0f%%", hits, len(fixture.Cases), accuracy*100)
	if accuracy < 0.9 {
		t.Fatalf("top-1 accuracy %.2f, want at least 0.90", accuracy)
	}
}

func TestRankLeavesOutArchivedAndTheAssistantsOwnAndUnmatched(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	digests := []store.WorkspaceDigest{
		{WorkspaceID: "ws_old", Name: "Old blog", Archived: true, L0: "blog"},
		{WorkspaceID: "ws_pa", Name: "Assistant blog", Kind: store.WorkspaceKindPersonalAgent},
		{WorkspaceID: "ws_tax", Name: "Tax"},
		{WorkspaceID: "ws_blog", Name: "Blog", DeviceOnline: true, CompiledAt: "2026-10-14T00:00:00Z", SummarizedAt: "2026-10-14T00:00:00Z"},
	}
	candidates := Rank("write a blog post", digests, nil, now, 5)
	if len(candidates) != 1 || candidates[0].WorkspaceID != "ws_blog" {
		t.Fatalf("candidates = %+v, want only ws_blog", candidates)
	}
	if candidates[0].Stale || !strings.Contains(candidates[0].Reason, `name matches "blog"`) {
		t.Fatalf("candidate = %+v, want fresh with the name as its reason", candidates[0])
	}
}

func TestRankCountsNotWhenAgainstAndNotesFor(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	digests := []store.WorkspaceDigest{
		{WorkspaceID: "ws_budget", Name: "Budget", Summary: "family spending and travel costs", NotWhen: []string{"travel costs"}},
		{WorkspaceID: "ws_trip", Name: "Trip", Summary: "itinerary"},
	}
	if got := Rank("log the travel costs", digests, nil, now, 5); len(got) != 0 {
		t.Fatalf("a request notWhen covers should not route there: %+v", got)
	}
	got := Rank("log the travel costs", digests, map[string]string{"ws_trip": "Wants travel costs here."}, now, 5)
	if len(got) != 1 || got[0].WorkspaceID != "ws_trip" || !strings.Contains(got[0].Reason, "your note") {
		t.Fatalf("the routing note should route it to ws_trip: %+v", got)
	}
}

func TestRankMarksStaleDigests(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	digests := []store.WorkspaceDigest{
		{WorkspaceID: "ws_a", Name: "Alpha notes", Dirty: true, CompiledAt: "2026-10-14T00:00:00Z", SummarizedAt: "2026-10-01T00:00:00Z"},
		{WorkspaceID: "ws_b", Name: "Beta notes", CompiledAt: "2026-09-01T00:00:00Z", SummarizedAt: "2026-09-01T00:00:00Z"},
		{WorkspaceID: "ws_c", Name: "Gamma notes", CompiledAt: "2026-10-14T00:00:00Z", SummarizedAt: "2026-10-14T00:00:00Z"},
	}
	stale := map[string]bool{}
	for _, candidate := range Rank("notes", digests, nil, now, 5) {
		stale[candidate.WorkspaceID] = candidate.Stale
	}
	if !stale["ws_a"] || !stale["ws_b"] || stale["ws_c"] {
		t.Fatalf("stale = %v, want dirty and week-old digests stale", stale)
	}
}

// A word in every project tells none apart, however rare it is among the
// person's requests; one only a single project holds decides.
func TestRankWeighsTermsByHowFewProjectsHoldThem(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	chatter := func(prefix string) []string {
		history := []string{}
		for i := 0; i < 10; i++ {
			history = append(history, fmt.Sprintf("%s request number %d", prefix, i))
		}
		return history
	}
	cliproxy := append(chatter("beta"), "check the cliproxy accounts", "cliproxy quota", "restart cliproxy", "cliproxy logs")
	records := []store.WorkspaceDigestRecord{
		{Digest: store.WorkspaceDigest{WorkspaceID: "ws_a", Name: "Rollout", L0: "rollout of the web app", RouteWhen: []string{"rollout"}}, History: chatter("alpha")},
		{Digest: store.WorkspaceDigest{WorkspaceID: "ws_b", Name: "Proxy"}, History: append(cliproxy, "a rollout once")},
		{Digest: store.WorkspaceDigest{WorkspaceID: "ws_c", Name: "Gamma"}, History: append(chatter("gamma"), "rollout notes")},
		{Digest: store.WorkspaceDigest{WorkspaceID: "ws_d", Name: "Delta"}, History: append(chatter("delta"), "rollout pipeline")},
	}
	got := RankRecords("rollout cliproxy", records, nil, now, 5)
	if len(got) == 0 || got[0].WorkspaceID != "ws_b" {
		t.Fatalf("the project only one holds a term of should come first: %+v", got)
	}
}

func TestCloseWhenTheFirstTwoScoreAlike(t *testing.T) {
	near := []store.WorkspaceCandidate{{Score: 0.81}, {Score: 0.79}}
	apart := []store.WorkspaceCandidate{{Score: 0.85}, {Score: 0.6}}
	if !Close(near) || Close(apart) || Close(near[:1]) || Close(nil) {
		t.Fatalf("Close: near %v, apart %v, one %v", Close(near), Close(apart), Close(near[:1]))
	}
}
