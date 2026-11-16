package store

import "testing"

// The input carries who or what started it (DEV-246), so viewers never read
// the prompt's markers; an explicit source wins over what its fields imply.
func TestSessionInputSourceIsStructured(t *testing.T) {
	cases := []struct {
		name  string
		input SendAgentSessionInput
		kind  string
		id    string
	}{
		{"person", SendAgentSessionInput{Prompt: "hello"}, "person", ""},
		{"another session", SendAgentSessionInput{SentBySessionID: "sess_a"}, "session", "sess_a"},
		{"scheduled timer", SendAgentSessionInput{TimerFire: &AgentSessionTimerFire{Origin: "scheduled"}}, "scheduled", ""},
		{"background work", SendAgentSessionInput{TimerFire: &AgentSessionTimerFire{Origin: "background"}}, "background", ""},
		{"channel", SendAgentSessionInput{ChannelOrigin: &MessageChannelOrigin{Source: "openlark"}}, "channel", ""},
		{"explicit report", SendAgentSessionInput{
			SentBySessionID: "sess_c",
			InputSource:     &AgentSessionInputSource{Kind: "child_report", SessionID: "sess_c", Status: "failed"},
		}, "child_report", "sess_c"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source := tc.input.InputSourceOf()
			if source.Kind != tc.kind || source.SessionID != tc.id {
				t.Fatalf("source = %+v, want kind %q session %q", source, tc.kind, tc.id)
			}
		})
	}

	// Every input event states it, and an explicit report keeps its status
	// and final answer for the row.
	events := SessionInputEvents("sess_p", SessionInput{
		ID:     "in_1",
		Prompt: "Foundry report: prose",
		InputSource: &AgentSessionInputSource{
			Kind: "child_report", SessionID: "sess_c", Title: "Deploy helper",
			Status: "completed", Response: "Deployed.",
		},
	})
	if len(events) != 1 || events[0].Metadata == nil || events[0].Metadata.InputSource == nil {
		t.Fatalf("input events = %+v, want one carrying its source", events)
	}
	got := events[0].Metadata.InputSource
	if got.Kind != "child_report" || got.Title != "Deploy helper" || got.Status != "completed" || got.Response != "Deployed." {
		t.Fatalf("event source = %+v", got)
	}
}

// A new session's first input says whether the person, its parent or a
// channel started it.
func TestNewSessionInputSourceIsStructured(t *testing.T) {
	if got := (CreateAgentSessionInput{}).FirstInputSource(); got.Kind != "person" {
		t.Fatalf("person source = %+v", got)
	}
	if got := (CreateAgentSessionInput{ParentSessionID: "sess_parent"}).FirstInputSource(); got.Kind != "session" || got.SessionID != "sess_parent" {
		t.Fatalf("parent source = %+v", got)
	}
	if got := (CreateAgentSessionInput{ChannelOrigin: &MessageChannelOrigin{Source: "openlark"}}).FirstInputSource(); got.Kind != "channel" {
		t.Fatalf("channel source = %+v", got)
	}
}
