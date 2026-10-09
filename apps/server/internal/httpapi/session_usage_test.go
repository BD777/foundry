package httpapi

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func usageEvent(id, at, label string, message *store.TranscriptMessage, usage *store.AgentTurnUsage) store.AgentSessionEvent {
	event := store.AgentSessionEvent{ID: id, At: at, Label: label, Message: message}
	if usage != nil {
		event.Metadata = &store.AgentSessionEventMetadata{TurnUsage: usage}
	}
	return event
}

// The agent log's turns land on the Foundry turn whose window holds them;
// a turn that already has usage keeps it, and a turn run outside Foundry
// before the session's turn is not counted.
func TestMatchSessionUsagePlacesNativeTurnsOnFoundryTurns(t *testing.T) {
	user := &store.TranscriptMessage{Kind: "user"}
	tool := &store.TranscriptMessage{Kind: "tool", CallID: "toolu_1"}
	live := &store.AgentTurnUsage{InputTokens: 1}
	events := []store.AgentSessionEvent{
		usageEvent("u1", "2026-10-01T10:00:00Z", "User message", user, nil),
		usageEvent("t1", "2026-10-01T10:00:10Z", "Used tool", tool, nil),
		usageEvent("f1", "2026-10-01T10:01:00Z", "Claude Agent SDK finished", nil, nil),
		usageEvent("u2", "2026-10-01T11:00:00Z", "User message", user, nil),
		usageEvent("f2", "2026-10-01T11:01:00Z", "Claude Agent SDK finished", nil, nil),
		usageEvent("u3", "2026-10-01T12:00:00Z", "User message", user, nil),
		usageEvent("f3", "2026-10-01T12:01:00Z", "Claude Agent SDK finished", nil, live),
	}
	turn := func(start, end string, input int64) nativeTurnUsage {
		return nativeTurnUsage{AgentTurnUsage: store.AgentTurnUsage{InputTokens: input, DurationMs: 1}, StartedAt: start, EndedAt: end}
	}
	native := wsSessionUsageRead{
		Turns: []nativeTurnUsage{
			turn("2026-10-01T10:00:01Z", "2026-10-01T10:00:30Z", 100),
			// A steered input inside the same Foundry turn.
			turn("2026-10-01T10:00:31Z", "2026-10-01T10:00:59Z", 50),
			// Run from the terminal between Foundry turns.
			turn("2026-10-01T10:30:00Z", "2026-10-01T10:31:00Z", 7),
			turn("2026-10-01T11:00:01Z", "2026-10-01T11:00:58Z", 300),
			turn("2026-10-01T12:00:01Z", "2026-10-01T12:00:58Z", 999),
		},
		Requests: []nativeRequestUsage{{Usage: store.ModelRequestUsage{RequestID: "msg_a", OutputTokens: 9}, ToolUseIDs: []string{"toolu_1"}}},
	}
	turns, requests := matchSessionUsage(events, native)
	if turns["f1"].InputTokens != 150 || turns["f1"].DurationMs != 60000 {
		t.Fatalf("first turn = %+v, want both native turns of its window over its 60s", turns["f1"])
	}
	if turns["f2"].InputTokens != 300 {
		t.Fatalf("second turn = %+v; the terminal turn before it must not count", turns["f2"])
	}
	if _, ok := turns["f3"]; ok {
		t.Fatal("a turn with live usage was overwritten")
	}
	if requests["t1"].RequestID != "msg_a" {
		t.Fatalf("tool step usage = %+v", requests["t1"])
	}
}

func TestMissingSessionUsage(t *testing.T) {
	finished := []store.AgentSessionEvent{{Label: "Codex SDK finished"}}
	if !missingSessionUsage(store.AgentSession{Provider: "codex", Status: "completed", NativeSessionID: "n", Events: finished}) {
		t.Fatal("a finished turn without usage needs backfill")
	}
	if missingSessionUsage(store.AgentSession{Provider: "codex", Status: "running", NativeSessionID: "n", Events: finished}) {
		t.Fatal("a running session is left alone")
	}
	if missingSessionUsage(store.AgentSession{Provider: "codex", Status: "completed", Events: finished}) {
		t.Fatal("without a native session there is no log to read")
	}
}

func TestUsageReadsEveryOwnedNativeSession(t *testing.T) {
	reads := map[string][]string{}
	usage, err := readOwnedSessionUsage([]store.NativeSessionRef{
		{Provider: "claude", NativeSessionID: "retired"},
		{Provider: "codex", NativeSessionID: "codex_current"},
		{Provider: "claude", NativeSessionID: "claude_current"},
	}, func(provider string, ids []string) (wsSessionUsageRead, error) {
		reads[provider] = ids
		at := map[string]string{"claude": "2026-10-09T02:00:00Z", "codex": "2026-10-09T01:00:00Z"}[provider]
		return wsSessionUsageRead{Turns: []nativeTurnUsage{{StartedAt: at}}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(reads["claude"], ",") != "retired,claude_current" || strings.Join(reads["codex"], ",") != "codex_current" {
		t.Fatalf("reads = %v; want every owned log of each provider", reads)
	}
	if len(usage.Turns) != 2 || usage.Turns[0].StartedAt != "2026-10-09T01:00:00Z" {
		t.Fatalf("turns = %+v; want both logs in time order", usage.Turns)
	}
}
