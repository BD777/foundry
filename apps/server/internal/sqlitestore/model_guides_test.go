package sqlitestore

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func openGuideStore(t *testing.T) *Store {
	t.Helper()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func guideEdit(summary string, apply func(*store.ModelGuide) error) store.ModelGuideEdit {
	return store.ModelGuideEdit{
		ChangeSummary: summary, Apply: apply,
		UpdatedBy: store.ModelGuideUpdater{UserID: "user_a", Name: "Alice", SessionID: "sess_a"},
	}
}

func TestModelGuideUpsertKeepsRevisionSnapshots(t *testing.T) {
	ctx := context.Background()
	db := openGuideStore(t)

	created, saved, err := db.EditModelGuide(ctx, "user_a", "deepseek-flash", guideEdit("first", func(g *store.ModelGuide) error {
		g.DisplayName, g.Sections.Summary = "DeepSeek Flash", "Cheap and fast."
		g.Aliases = []store.ModelGuideAlias{{ProviderKind: "api", ProviderID: "tokenhub", Runtime: "codex", Model: "deepseek-v4.1-flash-1017"}}
		return nil
	}))
	if err != nil || !saved || created.Revision != 1 || created.UpdatedBy.SessionID != "sess_a" {
		t.Fatalf("created = %+v saved %v err %v", created, saved, err)
	}
	if _, saved, err = db.EditModelGuide(ctx, "user_a", "deepseek-flash", guideEdit("same", func(g *store.ModelGuide) error {
		g.Sections.Summary = "Cheap and fast."
		return nil
	})); err != nil || saved {
		t.Fatalf("unchanged edit saved %v err %v", saved, err)
	}
	second, saved, err := db.EditModelGuide(ctx, "user_a", "deepseek-flash", guideEdit("pitfall seen in sess_x", func(g *store.ModelGuide) error {
		g.Sections.Pitfalls = "- Stops at the first failing test."
		return nil
	}))
	if err != nil || !saved || second.Revision != 2 || second.Sections.Summary != "Cheap and fast." || len(second.Aliases) != 1 {
		t.Fatalf("second = %+v saved %v err %v", second, saved, err)
	}

	first, err := db.GetModelGuideRevision(ctx, "user_a", "deepseek-flash", 1)
	if err != nil || first.ChangeSummary != "first" || first.Snapshot.Sections.Pitfalls != "" || first.Snapshot.Revision != 1 {
		t.Fatalf("revision 1 = %+v, %v", first, err)
	}
	latest, err := db.GetModelGuideRevision(ctx, "user_a", "deepseek-flash", 2)
	if err != nil || latest.Snapshot.Sections.Pitfalls == "" || len(latest.Snapshot.Aliases) != 1 {
		t.Fatalf("revision 2 = %+v, %v", latest, err)
	}
	history, err := db.ListModelGuideRevisions(ctx, "user_a", "deepseek-flash")
	if err != nil || len(history) != 2 || history[0].Revision != 2 || history[0].ChangeSummary != "pitfall seen in sess_x" || history[0].UpdatedBy.Name != "Alice" {
		t.Fatalf("history = %+v, %v", history, err)
	}
	if _, err := db.GetModelGuideRevision(ctx, "user_a", "deepseek-flash", 3); !errors.Is(err, store.ErrModelGuideRevisionNotFound) {
		t.Fatalf("missing revision = %v", err)
	}
	if _, err := db.GetModelGuide(ctx, "user_b", "deepseek-flash"); !errors.Is(err, store.ErrModelGuideNotFound) {
		t.Fatalf("another owner = %v", err)
	}
}

func TestModelGuideValidationAndAliasConflicts(t *testing.T) {
	ctx := context.Background()
	db := openGuideStore(t)
	named := func(name string) func(*store.ModelGuide) error {
		return func(g *store.ModelGuide) error { g.DisplayName = name; return nil }
	}
	if _, _, err := db.EditModelGuide(ctx, "user_a", "Bad Id", guideEdit("x", named("x"))); !errors.Is(err, store.ErrModelGuideInvalid) {
		t.Fatalf("bad id = %v", err)
	}
	if _, _, err := db.EditModelGuide(ctx, "user_a", "long", guideEdit("x", func(g *store.ModelGuide) error {
		g.DisplayName, g.Sections.Avoid = "Long", strings.Repeat("- one\n", 9)
		return nil
	})); !errors.Is(err, store.ErrModelGuideInvalid) {
		t.Fatalf("nine bullets = %v", err)
	}
	if _, err := db.GetModelGuide(ctx, "user_a", "long"); !errors.Is(err, store.ErrModelGuideNotFound) {
		t.Fatalf("rejected guide was saved: %v", err)
	}

	alias := store.ModelGuideAlias{ProviderKind: "api", ProviderID: "relay", Model: "Flash"}
	if _, _, err := db.EditModelGuide(ctx, "user_a", "one", guideEdit("x", func(g *store.ModelGuide) error {
		g.DisplayName, g.Aliases = "One", []store.ModelGuideAlias{alias}
		return nil
	})); err != nil {
		t.Fatal(err)
	}
	clash := alias
	clash.Model = "flash"
	_, _, err := db.EditModelGuide(ctx, "user_a", "two", guideEdit("x", func(g *store.ModelGuide) error {
		g.DisplayName, g.Aliases = "Two", []store.ModelGuideAlias{clash}
		return nil
	}))
	if !errors.Is(err, store.ErrModelGuideAliasTaken) || !strings.Contains(err.Error(), "one") {
		t.Fatalf("alias clash = %v", err)
	}
	if _, err := db.GetModelGuide(ctx, "user_a", "two"); !errors.Is(err, store.ErrModelGuideNotFound) {
		t.Fatalf("clashing guide was saved: %v", err)
	}
	if _, _, err := db.EditModelGuide(ctx, "user_b", "two", guideEdit("x", func(g *store.ModelGuide) error {
		g.DisplayName, g.Aliases = "Two", []store.ModelGuideAlias{clash}
		return nil
	})); err != nil {
		t.Fatalf("another owner may use the alias: %v", err)
	}
}

func TestModelGuideResolveByAliasAndSuggestedID(t *testing.T) {
	ctx := context.Background()
	db := openGuideStore(t)
	for id, aliases := range map[string][]store.ModelGuideAlias{
		"flash": {{Model: "deepseek-flash"}, {ProviderKind: "api", ProviderID: "relay", Runtime: "codex", Model: "DeepSeek/Flash"}},
		"other": {{ProviderKind: "api", ProviderID: "relay", Model: "deepseek-flash"}},
	} {
		aliases := aliases
		if _, _, err := db.EditModelGuide(ctx, "user_a", id, guideEdit("x", func(g *store.ModelGuide) error {
			g.DisplayName, g.Aliases = id, aliases
			return nil
		})); err != nil {
			t.Fatal(err)
		}
	}
	guide, alias, found, err := db.ResolveModelGuide(ctx, "user_a", store.ModelGuideAlias{
		ProviderKind: "api", ProviderID: "relay", Runtime: "codex", Model: "deepseek-flash"})
	if err != nil || !found || guide.ID != "other" || alias.ProviderID != "relay" {
		t.Fatalf("most specific alias = %+v %+v %v %v", guide.ID, alias, found, err)
	}
	guide, _, found, err = db.ResolveModelGuide(ctx, "user_a", store.ModelGuideAlias{ProviderKind: "subscription", ProviderID: "x", Model: "DEEPSEEK-FLASH"})
	if err != nil || !found || guide.ID != "flash" {
		t.Fatalf("wildcard alias, any case = %v %v %v", guide.ID, found, err)
	}
	guide, _, found, err = db.ResolveModelGuide(ctx, "user_a", store.ModelGuideAlias{Model: "deepseek/flash"})
	if err != nil || !found || guide.ID != "flash" {
		t.Fatalf("unconstrained target = %v %v %v", guide.ID, found, err)
	}
	if _, _, found, err = db.ResolveModelGuide(ctx, "user_b", store.ModelGuideAlias{Model: "deepseek-flash"}); err != nil || found {
		t.Fatalf("another owner found = %v, %v", found, err)
	}
	for model, want := range map[string]string{
		"deepseek-v4.1-flash-1017": "deepseek-v4.1-flash-1017",
		"DeepSeek/Flash Preview":   "flash-preview",
		"  claude-opus-4_1 ":       "claude-opus-4-1",
	} {
		if got := store.SuggestedModelGuideID(model); got != want || !store.ValidModelGuideID(got) {
			t.Fatalf("SuggestedModelGuideID(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestModelObservationsAppendOnlyAndPaged(t *testing.T) {
	ctx := context.Background()
	db := openGuideStore(t)
	if _, err := db.AppendModelObservation(ctx, "user_a", store.ModelObservation{GuideID: "missing", Body: "x"}); !errors.Is(err, store.ErrModelGuideNotFound) {
		t.Fatalf("observation on a missing guide = %v", err)
	}
	if _, _, err := db.EditModelGuide(ctx, "user_a", "flash", guideEdit("x", func(g *store.ModelGuide) error { g.DisplayName = "Flash"; return nil })); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"first", "second", "third"} {
		if _, err := db.AppendModelObservation(ctx, "user_a", store.ModelObservation{
			GuideID: "flash", Body: body, SessionIDs: []string{"sess_1", " "}, AuthorSessionID: "sess_a"}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}
	if _, err := db.AppendModelObservation(ctx, "user_a", store.ModelObservation{GuideID: "flash", Body: " "}); !errors.Is(err, store.ErrModelGuideInvalid) {
		t.Fatalf("empty observation = %v", err)
	}
	page, total, err := db.ListModelObservations(ctx, store.ModelObservationFilter{OwnerUserID: "user_a", GuideID: "flash", Limit: 2})
	if err != nil || total != 3 || len(page) != 2 || page[0].Body != "third" || len(page[0].SessionIDs) != 1 || page[0].AuthorSessionID != "sess_a" {
		t.Fatalf("page = %+v total %d err %v", page, total, err)
	}
	if _, total, _ = db.ListModelObservations(ctx, store.ModelObservationFilter{OwnerUserID: "user_b", GuideID: "flash"}); total != 0 {
		t.Fatalf("another owner's total = %d", total)
	}
}

func TestModelUsageSumsWorkerRequestsOfAliases(t *testing.T) {
	ctx := context.Background()
	db := openGuideStore(t)
	now := time.Now().UTC()
	record := func(id, session, parent, entry, profile, model string, at time.Time, output, generation, request int64, estimated bool) {
		t.Helper()
		if err := db.RecordUsage(ctx, store.UsageRecord{Requests: []store.UsageRequest{{
			RequestID: id, SessionID: session, InputID: "in_" + id, UserID: "user_a", ParentSessionID: parent,
			Entry: entry, At: formatTime(at), Runtime: "codex", ProfileID: profile, Model: model,
			OutputTokens: output, GenerationMs: generation, RequestMs: request, TimingEstimated: estimated,
		}}}); err != nil {
			t.Fatal(err)
		}
	}
	record("r1", "sess_w1", "sess_p", store.UsageEntryChatChild, "relay", "Flash", now.Add(-time.Hour), 100, 1000, 2000, false)
	record("r2", "sess_w1", "sess_p", store.UsageEntryChatChild, "relay", "flash", now.Add(-time.Hour), 300, 1000, 4000, false)
	record("r3", "sess_w2", "", store.UsageEntryIssue, "relay", "flash", now.Add(-time.Hour), 50, 500, 0, true)
	record("r4", "sess_chat", "", store.UsageEntryChat, "relay", "flash", now.Add(-time.Hour), 10, 0, 0, false)
	record("r5", "sess_old", "sess_p", store.UsageEntryChatChild, "relay", "flash", now.Add(-40*24*time.Hour), 10, 10, 10, false)
	record("r6", "sess_w3", "sess_p", store.UsageEntryChatChild, "elsewhere", "flash", now.Add(-time.Hour), 10, 10, 10, false)

	usage, err := db.ModelUsage(ctx, now.AddDate(0, 0, -30), "user_a", []store.ModelUsageTarget{{ProfileID: "relay", Runtime: "codex", Model: "flash"}})
	if err != nil {
		t.Fatal(err)
	}
	if usage.WorkerSessions != 2 || usage.Requests != 4 || usage.TimedRequests != 2 || usage.RequestMs != 6000 ||
		usage.ThroughputTokens != 400 || usage.GenerationMs != 2000 {
		t.Fatalf("usage = %+v", usage)
	}
	anyProvider, err := db.ModelUsage(ctx, now.AddDate(0, 0, -30), "user_a", []store.ModelUsageTarget{{Model: "flash"}})
	if err != nil || anyProvider.WorkerSessions != 3 {
		t.Fatalf("usage without a provider = %+v, %v", anyProvider, err)
	}
}
