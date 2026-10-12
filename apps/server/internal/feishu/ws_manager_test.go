package feishu

import (
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// eventsForTest is a stream for a manager to publish to.
func eventsForTest() *eventstream.Hub {
	return eventstream.New(eventstream.Control{})
}

// workspaceReachForTest is a stream that receives one workspace's messages.
type workspaceReachForTest string

func (r workspaceReachForTest) Receives(workspaceID string) bool { return workspaceID == string(r) }

func (workspaceReachForTest) Account() string { return "" }

func TestExtractMessageTextExtended(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "plain text message with mention",
			input:    `{"text":"@_user_1 /pair FND-CFTY"}`,
			expected: "/pair FND-CFTY",
		},
		{
			name:     "plain text message with multiple mentions",
			input:    `{"text":"@_user_1 @_user_2 hello world"}`,
			expected: "hello world",
		},
		{
			name:     "plain text message without mention",
			input:    `{"text":"/pair FND-CFTY"}`,
			expected: "/pair FND-CFTY",
		},
		{
			name: "post message with at and text elements",
			input: `{
				"title": "",
				"content": [
					[
						{"tag": "at", "user_id": "ou_12345", "user_name": "机智的打工人"},
						{"tag": "text", "text": " /pair FND-CFTY", "un_escape": true}
					]
				]
			}`,
			expected: "/pair FND-CFTY",
		},
		{
			name: "post message localized zh_cn",
			input: `{
				"zh_cn": {
					"title": "任务标题",
					"content": [
						[
							{"tag": "at", "user_id": "ou_12345", "user_name": "机智的打工人"},
							{"tag": "text", "text": " 请帮我审查代码"}
						],
						[
							{"tag": "text", "text": "第二行详细内容"}
						]
					]
				}
			}`,
			expected: "任务标题\n请帮我审查代码\n第二行详细内容",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractMessageText(tc.input)
			got = cleanLeadingMentions(got)
			if got != tc.expected {
				t.Errorf("extractMessageText(%s) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestCleanLeadingMentions(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"@机智的打工人 /pair FND-CFTY", "/pair FND-CFTY"},
		{"@bot1 @bot2 /pair FND-CFTY", "/pair FND-CFTY"},
		{"/pair FND-CFTY", "/pair FND-CFTY"},
		{"@bot", ""},
		{"hello world", "hello world"},
	}

	for _, tc := range tests {
		got := cleanLeadingMentions(tc.input)
		if got != tc.expected {
			t.Errorf("cleanLeadingMentions(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}

// A topic's card follows the session it started, as the server's session
// observer hands it over: the answer as it streams, then how the session
// ended. Other sessions' events and a second end change no card.
func TestTopicCardFollowsItsSession(t *testing.T) {
	manager := NewWSManager(nil, nil, nil, eventsForTest())
	manager.streamBuffer = NewStreamBuffer(time.Millisecond)
	bot := &fakeBot{}
	manager.apps["cli_x"] = &botApp{clientID: "cli_x", client: bot}
	manager.sessions["sess_1"] = &sessionMetadata{workspaceID: "ws_1", clientID: "cli_x", cardMessageID: "card_1", title: "Fix it", startTime: time.Now()}
	manager.sessions["sess_2"] = &sessionMetadata{workspaceID: "ws_1", clientID: "cli_x", cardMessageID: "card_2", title: "Break it", startTime: time.Now()}

	manager.SessionEventRecorded(store.AgentSessionEvent{SessionID: "sess_other", Label: "Response stream", Detail: "nobody's answer"})
	manager.SessionEventRecorded(store.AgentSessionEvent{SessionID: "sess_1", Label: "Response stream", Detail: "half an answer"})
	var streamed []struct{ to, card string }
	for deadline := time.Now().Add(3 * time.Second); len(streamed) == 0 && time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		streamed = bot.takePatches()
	}
	if len(streamed) != 1 || streamed[0].to != "card_1" || !strings.Contains(streamed[0].card, "half an answer") {
		t.Fatalf("streaming patched %+v, want card_1 with the answer so far", streamed)
	}

	manager.SessionEnded(store.AgentSession{ID: "sess_1", Status: "completed", Response: "the whole answer"})
	manager.SessionEnded(store.AgentSession{ID: "sess_1", Status: "completed", Response: "told again"})
	manager.SessionEnded(store.AgentSession{ID: "sess_2", Status: "failed", Error: "device went away"})
	ended := bot.takePatches()
	if len(ended) != 2 || ended[0].to != "card_1" || !strings.Contains(ended[0].card, "the whole answer") ||
		ended[1].to != "card_2" || !strings.Contains(ended[1].card, "device went away") {
		t.Fatalf("ends patched %+v, want card_1 completed and card_2 failed, once each", ended)
	}
	for _, patch := range ended {
		if strings.Contains(patch.card, "nobody's answer") || strings.Contains(patch.card, "told again") {
			t.Fatalf("a card shows what is not its session's: %s", patch.card)
		}
	}
}
