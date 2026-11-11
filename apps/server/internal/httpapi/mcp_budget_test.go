package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestMCPResultBudgetLogsTheOriginalSize(t *testing.T) {
	var logged bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(previous)
	large := strings.Repeat("x", defaultMCPResultBytes+500)
	boundMCPResultContent("list_models", nil, []any{map[string]any{"type": "text", "text": large}})
	message := logged.String()
	if !strings.Contains(message, "tool=list_models") || !strings.Contains(message, fmt.Sprintf("originalBytes=%d", len(large))) {
		t.Fatalf("truncation log = %q", message)
	}
}

func TestMCPResultBudgetCoversEveryTool(t *testing.T) {
	large := strings.Repeat("0123456789abcdef", 3_000)
	for _, tool := range remoteMCPTools {
		t.Run(tool.name, func(t *testing.T) {
			content := []any{map[string]any{"type": "text", "text": large}}
			bounded := boundMCPResultContent(tool.name, map[string]json.RawMessage{}, content)
			if got, limit := mcpTextContentBytes(bounded), mcpResultBudget(tool.name); got > limit {
				t.Fatalf("bounded text is %d bytes, over its %d-byte budget", got, limit)
			}
			text := fmt.Sprint(bounded[len(bounded)-1].(map[string]any)["text"])
			if !strings.Contains(text, "truncated") || !strings.Contains(text, "budget") {
				t.Fatalf("cut does not explain how large it was or its budget: %q", text)
			}
			continues := false
			for _, cue := range []string{"Pass ", "Narrow ", "Filter ", "Set ", "Read ", "Run "} {
				continues = continues || strings.Contains(text, cue)
			}
			if !continues {
				t.Fatalf("cut does not say how to continue: %q", text)
			}
		})
	}
}

func TestLargeMCPToolResultsStayWithinBudgets(t *testing.T) {
	workArgs := map[string]json.RawMessage{"limit": json.RawMessage(`100`)}
	workText, err := pageSessionWorkForMCP(store.SessionWorkList{Items: sessionWorkFixtures(120)}, workArgs)
	if err != nil {
		t.Fatal(err)
	}
	sessions := make([]mcpSessionItem, 100)
	for index := range sessions {
		sessions[index] = mcpSessionItem{
			ID: fmt.Sprintf("sess_%03d", index), Title: "session " + strings.Repeat("x", 80),
			Status: "completed", WorkspaceID: "ws_budget", ActivityAt: "2026-11-10T00:00:00Z",
		}
	}
	sessionText := fmt.Sprintf(`{"sessions":%s}`, encodeLines(sessions))
	events := make([]inspectEvent, 1_000)
	for index := range events {
		events[index] = inspectEvent{
			id: fmt.Sprintf("evt_%04d", index), at: "2026-11-10T00:00:00Z",
			level: "info", label: "event", detail: strings.Repeat("event detail ", 180),
		}
	}
	contextText, err := readEvents("sess_budget", events, eventQueryFromArgs(map[string]json.RawMessage{
		"limit": json.RawMessage(`500`),
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, tool, text string
	}{
		{name: "session work", tool: "list_session_work", text: workText},
		{name: "sessions", tool: "list_sessions", text: sessionText},
		{name: "events", tool: "read_context", text: contextText},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bounded := boundMCPResultContent(tc.tool, nil, []any{map[string]any{"type": "text", "text": tc.text}})
			if got, limit := mcpTextContentBytes(bounded), mcpResultBudget(tc.tool); got > limit {
				t.Fatalf("%s returned %d bytes, over %d", tc.tool, got, limit)
			}
		})
	}
}

func TestListSessionWorkPaginationCoversEveryItemOnce(t *testing.T) {
	items := sessionWorkFixtures(75)
	args := map[string]json.RawMessage{"limit": json.RawMessage(`13`)}
	seen := map[string]bool{}
	for pageNumber := 0; pageNumber < 20; pageNumber++ {
		text, err := pageSessionWorkForMCP(store.SessionWorkList{Items: items}, args)
		if err != nil {
			t.Fatal(err)
		}
		var page struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
			Total      int    `json:"total"`
			Remaining  int    `json:"remaining"`
			NextCursor string `json:"nextCursor"`
			Hint       string `json:"hint"`
		}
		if err := json.Unmarshal([]byte(text), &page); err != nil {
			t.Fatalf("page %d: %v\n%s", pageNumber, err, text)
		}
		if page.Total != len(items) {
			t.Fatalf("total = %d, want %d", page.Total, len(items))
		}
		if page.Remaining > 0 && (page.NextCursor == "" || page.Hint == "") {
			t.Fatalf("more items without a continuation: %s", text)
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatalf("item %s appeared twice", item.ID)
			}
			seen[item.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		args = map[string]json.RawMessage{
			"limit":  json.RawMessage(`13`),
			"cursor": json.RawMessage(fmt.Sprintf("%q", page.NextCursor)),
		}
	}
	if len(seen) != len(items) {
		t.Fatalf("pagination returned %d of %d items", len(seen), len(items))
	}

	text, err := pageSessionWorkForMCP(store.SessionWorkList{Items: items}, map[string]json.RawMessage{})
	if err != nil {
		t.Fatal(err)
	}
	var first struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(text), &first); err != nil || len(first.Items) != defaultSessionWorkLimit {
		t.Fatalf("default page has %d items (%v), want %d\n%s", len(first.Items), err, defaultSessionWorkLimit, text)
	}
	t.Logf("75-item session-work default page: %d bytes", len(text))
	text, err = pageSessionWorkForMCP(store.SessionWorkList{Items: items}, map[string]json.RawMessage{
		"detail": json.RawMessage(`true`),
		"limit":  json.RawMessage(`100`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(text), &first); err != nil || len(first.Items) != maxSessionWorkDetailLimit {
		t.Fatalf("detail page has %d items (%v), want %d\n%s", len(first.Items), err, maxSessionWorkDetailLimit, text)
	}

	statusArgs := map[string]json.RawMessage{
		"status":        json.RawMessage(`["running"]`),
		"itemSessionId": json.RawMessage(`"sess_budget_005"`),
	}
	filtered := filterSessionWorkItems(items, statusArgs)
	if len(filtered) != 1 || filtered[0].ID != "work_005" {
		t.Fatalf("status/session filter = %+v", filtered)
	}
}

func sessionWorkFixtures(count int) []store.SessionWork {
	items := make([]store.SessionWork, count)
	base := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	for index := range items {
		status := "running"
		if index%3 == 0 {
			status = "completed"
		}
		items[index] = store.SessionWork{
			ID: fmt.Sprintf("work_%03d", index), SessionID: fmt.Sprintf("sess_budget_%03d", index),
			WorkspaceID: "ws_budget", DeviceID: "dev_budget", Kind: "schedule", Source: "foundry",
			Title:      fmt.Sprintf("maintenance %03d %s", index, strings.Repeat("x", 100)),
			Management: "managed", DesiredState: "enabled", Revision: 1, Generation: 1,
			CreatedAt: base.Add(time.Duration(index) * time.Minute).Format(time.RFC3339),
			UpdatedAt: base.Add(time.Duration(index) * time.Minute).Format(time.RFC3339),
			Spec:      store.WorkSpec{Prompt: "inspect"},
			Observation: store.WorkObservation{
				Status: status, At: base.Add(time.Duration(index) * time.Minute).Format(time.RFC3339),
				ConfirmedRevision: 1,
			},
			AllowedActions: []string{"stop", "pause"},
		}
	}
	return items
}

func TestListModelsPagesOnlyChatModels(t *testing.T) {
	models := []store.AgentModelOption{}
	for index := 0; index < 100; index++ {
		models = append(models, store.AgentModelOption{
			ID: fmt.Sprintf("vendor/chat-%03d", index), Label: fmt.Sprintf("Chat %03d", index),
			ContextWindow: int64(32_000 + index),
		})
	}
	for _, id := range []string{
		"vendor/image-gen", "vendor/video-1", "vendor/audio-preview", "vendor/embedding-base",
		"vendor/whisper", "vendor/flux-2", "vendor/veo-4", "vendor/tripo-3d",
	} {
		models = append(models, store.AgentModelOption{ID: id})
	}
	for index := 0; index < 12; index++ {
		models = append(models, store.AgentModelOption{ID: fmt.Sprintf("vendor/embedding-%02d", index)})
	}
	profile := store.AgentProfileProjection{ID: "prof_budget", Runtime: "codex"}
	args := map[string]json.RawMessage{}
	text, err := pageAgentModelsForMCP(profile, models, args)
	if err != nil {
		t.Fatal(err)
	}
	var page mcpModelPage
	if err := json.Unmarshal([]byte(text), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Models) != defaultMCPModelLimit || page.Total != 100 || page.NextOffset == nil || *page.NextOffset != defaultMCPModelLimit {
		t.Fatalf("first page = %+v", page)
	}
	t.Logf("120-model catalog first page: %d bytes", len(text))
	if !strings.Contains(page.Hint, "70 more chat-capable models") {
		t.Fatalf("hint = %q", page.Hint)
	}
	raw, _ := json.Marshal(page.Models[0])
	if got := string(raw); got != `{"id":"vendor/chat-000","label":"Chat 000","contextWindow":32000}` {
		t.Fatalf("item carries more than id, label and contextWindow: %s", got)
	}

	all := 0
	for offset := 0; ; {
		text, err := pageAgentModelsForMCP(profile, models, map[string]json.RawMessage{
			"offset": json.RawMessage(fmt.Sprint(offset)),
			"limit":  json.RawMessage(`100`),
		})
		if err != nil {
			t.Fatal(err)
		}
		var page mcpModelPage
		if err := json.Unmarshal([]byte(text), &page); err != nil {
			t.Fatal(err)
		}
		all += len(page.Models)
		if page.NextOffset == nil {
			break
		}
		offset = *page.NextOffset
	}
	if all != 100 {
		t.Fatalf("paged through %d chat models, want 100", all)
	}

	queryText, err := pageAgentModelsForMCP(profile, models, map[string]json.RawMessage{
		"query":  json.RawMessage(`"chat-08"`),
		"limit":  json.RawMessage(`100`),
		"offset": json.RawMessage(`0`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var queried mcpModelPage
	if err := json.Unmarshal([]byte(queryText), &queried); err != nil || queried.Total != 10 {
		t.Fatalf("query total = %d, want 10: %v\n%s", queried.Total, err, queryText)
	}
}

func TestChatModelForRuntimeUsesTheRuntimeAndModality(t *testing.T) {
	for _, tc := range []struct {
		runtime string
		model   store.AgentModelOption
		want    bool
	}{
		{"claude", store.AgentModelOption{ID: "us.anthropic.claude-sonnet-5"}, true},
		{"claude", store.AgentModelOption{ID: "gpt-6"}, false},
		{"codex", store.AgentModelOption{ID: "deepseek-chat"}, true},
		{"codex", store.AgentModelOption{ID: "gpt-image-1"}, false},
		{"codex", store.AgentModelOption{ID: "text-embedding-4"}, false},
		{"codex", store.AgentModelOption{ID: "vendor-tts"}, false},
		{"codex", store.AgentModelOption{ID: "vendor-video"}, false},
	} {
		if got := chatModelForRuntime(tc.runtime, tc.model); got != tc.want {
			t.Errorf("%s %s = %v, want %v", tc.runtime, tc.model.ID, got, tc.want)
		}
	}
}
