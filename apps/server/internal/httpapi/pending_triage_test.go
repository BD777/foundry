package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A triage's prompt says what it reads, so its completion finds the chat
// again; its answer becomes pending items only where it quotes the answer
// (DEV-125). A repeated request is the open item it names; settled ones
// close; offers and requests that quote nothing are dropped.
func TestTriageKeepsWhatTheAnswerAsks(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	answer := "MR-2a is merged.\n\nStill waiting on your decisions:\n1. **Meego tags:** do you confirm the 8-layer funnel as the main one?\n2. Whether to start P0–P1 of the dependency protocol.\n\nIf you need it, I can also draft the note."
	open := []store.PendingItem{{ID: "pnd_old", Title: "Start P0–P1 of the dependency protocol?"}}
	prompt := triagePrompt(f.session.ID, "msg_9", "rev_3", answer, "先看看 MR-2a", open)
	header := triageHeader.FindStringSubmatch(prompt)
	if header == nil || header[1] != f.session.ID || header[2] != "msg_9" || header[3] != "rev_3" {
		t.Fatalf("header = %v", header)
	}
	if !strings.Contains(prompt, "- pnd_old: Start P0–P1") || !strings.Contains(prompt, "先看看 MR-2a") || !strings.Contains(prompt, answer) {
		t.Fatalf("prompt misses its parts:\n%s", prompt)
	}

	// An open request from an earlier answer, which this one repeats.
	repeated, _, err := f.server.store.RecordPendingItem(ctx, store.PendingItem{UserID: f.session.CreatedByUserID, WorkspaceID: f.session.WorkspaceID, SessionID: f.session.ID,
		EventID: "answer:rev_1:msg_1", Source: store.PendingSourceAnswer, Rule: "decision", Key: "answer:" + f.session.ID + ":p0", Title: "Start P0–P1?", Excerpt: "Whether to start P0–P1 of the dependency protocol."})
	if err != nil {
		t.Fatal(err)
	}
	settled, _, err := f.server.store.RecordPendingItem(ctx, store.PendingItem{UserID: f.session.CreatedByUserID, WorkspaceID: f.session.WorkspaceID, SessionID: f.session.ID,
		EventID: "answer:rev_1:msg_1", Source: store.PendingSourceAnswer, Rule: "decision", Key: "answer:" + f.session.ID + ":old", Title: "Merge MR-2a?", Excerpt: "Merge MR-2a?"})
	if err != nil {
		t.Fatal(err)
	}
	prompt = triagePrompt(f.session.ID, "msg_9", "rev_3", answer, "", nil)
	response := "```json\n" + `{"items":[
		{"kind":"decision","quote":"**Meego tags:** do you confirm the 8-layer funnel as the main one?","question":"Confirm the 8-layer funnel?","options":["yes","no"]},
		{"kind":"decision","quote":"Whether to start P0–P1 of the dependency protocol.","question":"Start P0–P1?","same":"` + repeated.ID + `"},
		{"kind":"offer","quote":"If you need it, I can also draft the note.","question":"Draft the note?"},
		{"kind":"action","quote":"Sign the release form.","question":"Sign it?"}
	],"closes":["` + settled.ID + `","pnd_elsewhere"]}` + "\n```"
	f.server.finishTriage(ctx, store.AgentSession{ID: "sess_triage", Status: "completed", Source: store.SessionSourceTriage, Prompt: prompt, Response: response})

	answers := []pendingItemView{}
	for _, item := range f.list().Items {
		if item.Source == store.PendingSourceAnswer {
			answers = append(answers, item)
		}
	}
	byTitle := map[string]pendingItemView{}
	for _, item := range answers {
		byTitle[item.Title] = item
	}
	funnel := byTitle["Confirm the 8-layer funnel?"]
	if funnel.State != store.PendingOpen || funnel.MessageID != "msg_9" || funnel.Rule != "decision" || len(funnel.Options) != 2 ||
		!strings.Contains(funnel.Excerpt, "8-layer funnel") {
		t.Fatalf("funnel item = %+v", funnel)
	}
	if again := byTitle["Start P0–P1?"]; again.ID != repeated.ID || again.Occurrences != 2 || again.State != store.PendingOpen {
		t.Fatalf("repeated request = %+v", again)
	}
	if old := byTitle["Merge MR-2a?"]; old.State != store.PendingReplied {
		t.Fatalf("settled request = %+v", old)
	}
	if _, offered := byTitle["Draft the note?"]; offered {
		t.Fatal("an offer became an item")
	}
	if _, invented := byTitle["Sign it?"]; invented {
		t.Fatal("a request that quotes nothing in the answer became an item")
	}
	if len(answers) != 3 {
		t.Fatalf("answer items = %+v", answers)
	}
	if _, ok := parseTriage("no json here"); ok {
		t.Fatal("parsed text without JSON")
	}
}

// A session another session started reports to it: it is not the
// person's chat, so nothing in it waits for them.
func TestPendingChatIsOnlyThePersonsOwn(t *testing.T) {
	chat := store.AgentSession{CreatedByUserID: "user_1", Source: store.SessionSourceChat}
	if !pendingChat(chat) {
		t.Fatal("the person's chat")
	}
	chat.ParentSessionID = "sess_parent"
	if pendingChat(chat) {
		t.Fatal("a scheduled or orchestrated session counted as the person's chat")
	}
}

// The person chooses what reads their answers: off until chosen, only on
// their own device, an effort the runtime has; off keeps the choice.
func TestTriageSettingsAreThePersonsChoice(t *testing.T) {
	f := newIsolationFixture(t)
	call := func(cookie, method, body string) (int, store.PendingTriageSettings) {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(cookie, method, "/api/pending-items/triage", body))
		var settings store.PendingTriageSettings
		_ = json.Unmarshal(recorder.Body.Bytes(), &settings)
		return recorder.Code, settings
	}
	if code, settings := call(f.alice, http.MethodGet, ""); code != http.StatusOK || settings.Enabled {
		t.Fatalf("unchosen = %d %+v", code, settings)
	}
	if code, _ := call(f.alice, http.MethodPut, `{"enabled":true,"deviceId":"dev_bob","runtime":"claude","profileId":"prof_x","model":"m","effort":"low"}`); code != http.StatusForbidden {
		t.Fatalf("another person's device = %d", code)
	}
	if code, _ := call(f.alice, http.MethodPut, `{"enabled":true,"deviceId":"dev_alice","runtime":"claude","profileId":"prof_x","effort":"minimal"}`); code != http.StatusBadRequest {
		t.Fatalf("an effort Claude does not have = %d", code)
	}
	code, saved := call(f.alice, http.MethodPut, `{"enabled":true,"deviceId":"dev_alice","runtime":"claude","profileId":"prof_x","model":"gemini-3.8-flash-high","effort":"low"}`)
	if code != http.StatusOK || !saved.Enabled || saved.Model != "gemini-3.8-flash-high" || saved.UpdatedAt == "" {
		t.Fatalf("saved = %d %+v", code, saved)
	}
	if code, off := call(f.alice, http.MethodPut, `{"enabled":false,"deviceId":"dev_alice","runtime":"claude","profileId":"prof_x","model":"gemini-3.8-flash-high","effort":"low"}`); code != http.StatusOK || off.Enabled || off.Model == "" {
		t.Fatalf("off = %d %+v", code, off)
	}
	if code, bob := call(f.bob, http.MethodGet, ""); code != http.StatusOK || bob.Enabled || bob.Model != "" {
		t.Fatalf("bob's = %d %+v", code, bob)
	}
}

// The answer is named as the transcript names it, so its item opens on it:
// the assistant message's id, or the event's for an answer streamed
// without a message (Claude); never a sub-agent's or a question's.
func TestTriageNamesTheAnswerAsTheTranscriptDoes(t *testing.T) {
	stream := store.AgentSessionEvent{ID: "evt_answer", Label: store.EventLabelResponseStream, Detail: "Which one?"}
	task := store.AgentSessionEvent{ID: "evt_task", Label: store.EventLabelResponseStream, Detail: "child", Metadata: &store.AgentSessionEventMetadata{TaskID: "task_1"}}
	question := store.AgentSessionEvent{ID: "evt_q", Label: store.EventLabelResponseStream, Message: &store.TranscriptMessage{ID: "in/call", Kind: "assistant", Questions: []store.AgentQuestion{{Title: "A?"}}}}
	if got := triageMessageID(store.AgentSession{Events: []store.AgentSessionEvent{stream, task, question}}); got != "evt_answer" {
		t.Fatalf("streamed answer = %q", got)
	}
	codex := store.AgentSessionEvent{ID: "evt_codex", Label: store.EventLabelResponseStream, Message: &store.TranscriptMessage{ID: "item_7", Kind: "assistant", Text: "Which one?"}}
	if got := triageMessageID(store.AgentSession{Events: []store.AgentSessionEvent{stream, codex}}); got != "item_7" {
		t.Fatalf("message answer = %q", got)
	}
}
