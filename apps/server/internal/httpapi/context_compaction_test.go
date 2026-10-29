package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A compaction's counts and the summary the agent continued from survive
// the device's report and the browser's read (DEV-083).
func TestContextCompactionKeepsItsSummary(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "running", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{session.ID})
	daemon.write("compaction", wsSessionEventType, map[string]any{"event": map[string]any{
		"id": "evt_compaction", "sessionId": session.ID, "label": "Model request usage", "level": "info",
		"metadata": map[string]any{"contextUsage": map[string]any{
			"inputTokens": 38200, "contextWindow": 1000000,
			"compaction": map[string]any{"trigger": "manual", "preTokens": 951800, "postTokens": 38200},
		}},
	}})
	daemon.write("summary", wsSessionEventType, map[string]any{"event": map[string]any{
		"id": "evt_summary", "sessionId": session.ID, "label": "The native session compacted its context.", "level": "info",
		"message": map[string]any{
			"id": "compaction-summary:b1", "kind": "boundary", "text": "The native session compacted its context.",
			"compaction": map[string]any{"trigger": "manual", "summary": "What the agent continues from."},
		},
	}})
	var read struct {
		Events []store.AgentSessionEvent `json:"events"`
	}
	waitForTest(t, "both events to be recorded", func() bool {
		status, raw := client.call(http.MethodGet, "/api/agent-sessions/"+session.ID, "", "")
		if status != http.StatusOK || json.Unmarshal(raw, &read) != nil {
			return false
		}
		found := 0
		for _, event := range read.Events {
			if event.ID == "evt_compaction" || event.ID == "evt_summary" {
				found++
			}
		}
		return found == 2
	})
	for _, event := range read.Events {
		switch event.ID {
		case "evt_compaction":
			compaction := event.Metadata.ContextUsage.Compaction
			if compaction == nil || compaction.PostTokens == nil || *compaction.PostTokens != 38200 || *compaction.PreTokens != 951800 {
				t.Fatalf("compaction = %+v", compaction)
			}
		case "evt_summary":
			if event.Message == nil || event.Message.Compaction == nil || event.Message.Compaction.Summary != "What the agent continues from." {
				t.Fatalf("summary message = %+v", event.Message)
			}
		}
	}
}
