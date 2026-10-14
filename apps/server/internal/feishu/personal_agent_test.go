package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents/feishueventstest"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

// fakeAssistant stands in for the server's assistant core.
type fakeAssistant struct {
	mu        sync.Mutex
	route     PersonalAgentRoute
	pending   []store.PersonalAgentProposal
	priors    []string
	stops     []string
	resumes   int
	decisions []string
	// language is the one the person chose, "" for none.
	language string
	// introduced are the user/app pairs told the assistant took over.
	introduced map[string]bool
}

func (a *fakeAssistant) ClaimIntroduction(_ context.Context, userID, appID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.introduced == nil {
		a.introduced = map[string]bool{}
	}
	if a.introduced[userID+"/"+appID] {
		return false
	}
	a.introduced[userID+"/"+appID] = true
	return true
}

// Word classifies as personalagent's word lists do.
func (a *fakeAssistant) Word(text string) string {
	words := map[string][]string{
		PersonalAgentWordStop:    {"停", "停下", "停止", "暂停", "stop", "pause"},
		PersonalAgentWordResume:  {"继续", "resume"},
		PersonalAgentWordAccept:  {"好", "好的", "可以", "行", "ok", "yes"},
		PersonalAgentWordDecline: {"不", "不用", "算了", "no"},
	}
	for meaning, list := range words {
		for _, word := range list {
			if strings.EqualFold(strings.TrimSpace(text), word) {
				return meaning
			}
		}
	}
	return ""
}

// Language answers as personalagent.ReplyLanguage does.
func (a *fakeAssistant) Language(_ context.Context, _, message string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.language != "" {
		return a.language
	}
	for _, r := range message {
		if unicode.Is(unicode.Han, r) {
			return "zh"
		}
	}
	if strings.IndexFunc(message, unicode.IsLetter) >= 0 {
		return "en"
	}
	return "zh"
}

func (a *fakeAssistant) Route(_ context.Context, userID, _ string, routeWorkspaceID string) (PersonalAgentRoute, bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.priors = append(a.priors, routeWorkspaceID)
	return a.route, a.route.WorkspaceID != "", nil
}

func (a *fakeAssistant) Stop(_ context.Context, userID, via string) (PersonalAgentStopped, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stops = append(a.stops, userID+"/"+via)
	a.route.Stopped = true
	return PersonalAgentStopped{Cancelled: 2}, nil
}

func (a *fakeAssistant) Resume(context.Context, string, string) (PersonalAgentResumed, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.resumes++
	a.route.Stopped = false
	return PersonalAgentResumed{Stopped: []string{"Family budget page"}}, nil
}

func (a *fakeAssistant) PendingProposals(context.Context, string) ([]store.PersonalAgentProposal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]store.PersonalAgentProposal(nil), a.pending...), nil
}

func (a *fakeAssistant) decide(userID, proposalID, via, status string) (store.PersonalAgentProposal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for index, proposal := range a.pending {
		if proposal.ID == proposalID && proposal.UserID == userID {
			a.pending = append(a.pending[:index], a.pending[index+1:]...)
			a.decisions = append(a.decisions, status+" "+proposalID+" via "+via)
			proposal.Status, proposal.DecidedVia = status, via
			return proposal, nil
		}
	}
	return store.PersonalAgentProposal{}, errors.New("no such pending proposal")
}

func (a *fakeAssistant) Accept(_ context.Context, userID, proposalID, via string) (store.PersonalAgentProposal, error) {
	return a.decide(userID, proposalID, via, store.PersonalAgentProposalAccepted)
}

func (a *fakeAssistant) Decline(_ context.Context, userID, proposalID, via string) (store.PersonalAgentProposal, error) {
	return a.decide(userID, proposalID, via, store.PersonalAgentProposalDeclined)
}

func (a *fakeAssistant) set(change func(*fakeAssistant)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	change(a)
}

// assistantFixture: ws_1 is a project the person's direct chat oc_dm and
// group oc_1 were paired with; ws_pa is their Personal Agent Workspace.
type assistantFixture struct {
	db         *sqlitestore.Store
	person     store.User
	manager    *WSManager
	dispatcher *recordingDispatcher
	desk       *fakeAssistant
	bot        *fakeBot
	app        *botApp
}

func newAssistantFixture(t *testing.T) assistantFixture {
	t.Helper()
	ctx := context.Background()
	db := openPairingTestStore(t)
	addWorkspace(t, db, "ws_pa")
	if err := db.SetWorkspaceKind(ctx, "ws_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	person := addUser(t, db, "person", store.WorkspaceRoleMember)
	if err := db.SetWorkspaceMember(ctx, "ws_pa", person.ID, store.WorkspaceRoleOwner, person.ID); err != nil {
		t.Fatal(err)
	}
	direct := bindChat(t, db, "ws_1", "cli_x", "oc_dm", store.FeishuRouteP2P, person.ID)
	if err := db.SetFeishuChatPeer(ctx, direct.ID, "ou_person"); err != nil {
		t.Fatal(err)
	}
	bindGroup(t, db, person.ID)
	dispatcher := &recordingDispatcher{}
	manager := NewWSManager(db, allSecrets{}, dispatcher, eventsForTest())
	desk := &fakeAssistant{route: PersonalAgentRoute{WorkspaceID: "ws_pa", TakesDirectChats: true}}
	manager.PersonalAgents = desk
	bot := &fakeBot{}
	app := &botApp{clientID: "cli_x", client: bot}
	manager.apps["cli_x"] = app
	return assistantFixture{db: db, person: person, manager: manager, dispatcher: dispatcher, desk: desk, bot: bot, app: app}
}

// personMessage is the person's (sender) message in their direct chat.
func personMessage(id, root, text, sender string) *larkim.P2MessageReceiveV1 {
	message := groupMessage(id, root, text, false)
	chat, kind := "oc_dm", "p2p"
	message.Event.Message.ChatId, message.Event.Message.ChatType = &chat, &kind
	message.Event.Sender.SenderId = &larkim.UserId{OpenId: &sender}
	return message
}

func (f assistantFixture) send(t *testing.T, message *larkim.P2MessageReceiveV1) {
	t.Helper()
	if err := f.manager.handleMessage(context.Background(), f.app, message); err != nil {
		t.Fatal(err)
	}
}

func (f assistantFixture) started() []store.CreateAgentSessionInput {
	f.dispatcher.mu.Lock()
	defer f.dispatcher.mu.Unlock()
	return append([]store.CreateAgentSessionInput(nil), f.dispatcher.started...)
}

func repliesContain(replies []struct{ to, card string }, to, text string) bool {
	for _, reply := range replies {
		if reply.to == to && strings.Contains(reply.card, text) {
			return true
		}
	}
	return false
}

// The person's direct chat goes to their assistant while it takes direct
// chats, with the chat's own workspace handed over as the prior; turning
// that off sends it back, since the stored route never changed. The group
// keeps going to its workspace throughout.
func TestDirectChatGoesToTheAssistantReversibly(t *testing.T) {
	ctx := context.Background()
	f := newAssistantFixture(t)
	f.desk.set(func(a *fakeAssistant) { a.route.Introduce = true })

	f.send(t, personMessage("om_1", "", "help me track family spending", "ou_person"))
	f.send(t, groupMessage("om_g1", "", "@_user_1 fix the build", true))
	started := f.started()
	if len(started) != 2 || started[0].WorkspaceID != "ws_pa" || started[0].CreatedByUserID != f.person.ID || started[1].WorkspaceID != "ws_1" {
		t.Fatalf("started %+v, want the direct message in ws_pa as the person and the group's in ws_1", started)
	}
	if len(f.desk.priors) == 0 || f.desk.priors[0] != "ws_1" {
		t.Fatalf("the desk was told the prior %v, want ws_1", f.desk.priors)
	}
	if !repliesContain(f.bot.take(), "om_1", "go to “W”") {
		t.Fatal("the first message was not told, once, that the assistant took the chat over from ws_1")
	}
	f.send(t, personMessage("om_1b", "", "and the monthly totals", "ou_person"))
	if repliesContain(f.bot.take(), "om_1b", "go to “W”") {
		t.Fatal("the chat was told again that the assistant took it over")
	}
	if route, err := f.db.FindFeishuChatRoute(ctx, "cli_x", "oc_dm"); err != nil || route.WorkspaceID != "ws_1" {
		t.Fatalf("the stored route = %+v %v, want it unchanged on ws_1", route, err)
	}

	f.desk.set(func(a *fakeAssistant) { a.route.TakesDirectChats, a.route.Introduce = false, false })
	f.send(t, personMessage("om_2", "", "summarise the repo", "ou_person"))
	if started := f.started(); len(started) != 4 || started[3].WorkspaceID != "ws_1" {
		t.Fatalf("after turning it off the direct message started %+v, want ws_1", started[len(started)-1])
	}
}

// Stop, resume and yes/no are the server's, before the model, and only the
// paired person's; groups are untouched.
func TestAssistantWordsAreHandledBeforeTheModel(t *testing.T) {
	f := newAssistantFixture(t)

	// A group's "停" is a message for the group's workspace, as ever.
	f.send(t, groupMessage("om_g", "", "@_user_1 停", true))
	if started := f.started(); len(started) != 1 || started[0].WorkspaceID != "ws_1" || len(f.desk.stops) != 0 {
		t.Fatalf("a group's stop word: started %+v, stops %v", started, f.desk.stops)
	}

	// Someone other than the paired person cannot press the switch.
	f.send(t, personMessage("om_x", "", "stop", "ou_stranger"))
	if len(f.desk.stops) != 0 {
		t.Fatalf("a stranger stopped the assistant: %v", f.desk.stops)
	}

	before := len(f.started())
	f.send(t, personMessage("om_stop", "", " STOP ", "ou_person"))
	if len(f.desk.stops) != 1 || f.desk.stops[0] != f.person.ID+"/feishu" || len(f.started()) != before {
		t.Fatalf("stop: %v, %d sessions started, want the switch pressed and no session", f.desk.stops, len(f.started())-before)
	}
	replies := f.bot.take()
	if !repliesContain(replies, "om_stop", "2 thing(s) that were running") || !repliesContain(replies, "om_stop", `"op":"resume"`) {
		t.Fatalf("the stop was answered %+v, want the fixed text with a resume button", replies)
	}

	// While stopped, nothing reaches the model; "继续" resumes.
	f.send(t, personMessage("om_while", "", "make me a page", "ou_person"))
	f.send(t, personMessage("om_resume", "", "继续", "ou_person"))
	replies = f.bot.take()
	if len(f.started()) != before || !repliesContain(replies, "om_while", "Your assistant is stopped") ||
		f.desk.resumes != 1 || !repliesContain(replies, "om_resume", "Family budget page") {
		t.Fatalf("while stopped: %d started, resumes %d, replies %+v", len(f.started())-before, f.desk.resumes, replies)
	}

	// A topic of the assistant's: its session asks for approval; "好" in the
	// topic accepts that proposal without the model.
	f.send(t, personMessage("om_topic", "", "archive the old blog", "ou_person"))
	topicSession := fmt.Sprintf("sess_%d", len(f.started()))
	f.desk.set(func(a *fakeAssistant) {
		a.pending = []store.PersonalAgentProposal{{ID: "pap_1", UserID: f.person.ID, SessionID: topicSession, Kind: "archive_workspace", Summary: "把『旧博客』收起来", Status: store.PersonalAgentProposalPending}}
	})
	started := len(f.started())
	f.send(t, personMessage("om_yes", "om_topic", "好", "ou_person"))
	if len(f.desk.decisions) != 1 || f.desk.decisions[0] != "accepted pap_1 via reply" || len(f.started()) != started {
		t.Fatalf("decisions %v, want pap_1 accepted by the reply and nothing sent on", f.desk.decisions)
	}
	if len(f.dispatcher.sent) != 0 {
		t.Fatalf("the yes reached the session: %+v", f.dispatcher.sent)
	}

	// With nothing pending at the top level, "好" is just a message.
	f.send(t, personMessage("om_ok", "", "ok", "ou_person"))
	if len(f.started()) != started+1 {
		t.Fatal("an ok with nothing to answer did not reach the assistant")
	}
}

// A proposal's card goes to the topic of the conversation that made it,
// with buttons only the paired person can press, in that chat.
func TestProposalCardButtonsAreThePairedPersons(t *testing.T) {
	ctx := context.Background()
	f := newAssistantFixture(t)
	f.send(t, personMessage("om_topic", "", "archive the old blog", "ou_person"))
	f.bot.take()
	proposal := store.PersonalAgentProposal{ID: "pap_1", UserID: f.person.ID, SessionID: "sess_1", Summary: "把『旧博客』收起来", Status: store.PersonalAgentProposalPending}
	f.desk.set(func(a *fakeAssistant) { a.pending = []store.PersonalAgentProposal{proposal} })
	f.manager.postProposal(ctx, proposal)
	replies := f.bot.take()
	if len(replies) != 1 || replies[0].to != "om_topic" || !strings.Contains(replies[0].card, `"proposalId":"pap_1"`) || !strings.Contains(replies[0].card, "不用了") {
		t.Fatalf("the proposal was posted %+v, want a card with buttons in its topic", replies)
	}
	cardID := "card_om_topic"

	press := func(eventID, operator, chatID string) {
		payload := feishueventstest.EventPayload("cli_x", eventID, cardActionTriggered, map[string]any{
			"operator": map[string]string{"open_id": operator},
			"action":   map[string]any{"tag": "button", "value": map[string]string{"foundry": "personal_agent", "op": "accept", "proposalId": "pap_1"}},
			"context":  map[string]string{"open_message_id": cardID, "open_chat_id": chatID},
		})
		f.manager.HandleEvent(ctx, feishuevents.Event{AppID: "cli_x", ID: eventID, Type: cardActionTriggered, Payload: json.RawMessage(payload)})
	}
	press("ev_stranger", "ou_stranger", "oc_dm")
	press("ev_group", "ou_person", "oc_1")
	if len(f.desk.decisions) != 0 {
		t.Fatalf("a press by someone else or in a group decided: %v", f.desk.decisions)
	}
	press("ev_person", "ou_person", "oc_dm")
	if len(f.desk.decisions) != 1 || f.desk.decisions[0] != "accepted pap_1 via feishu" {
		t.Fatalf("decisions %v, want pap_1 accepted by the button", f.desk.decisions)
	}
	patches := f.bot.takePatches()
	if len(patches) != 1 || patches[0].to != cardID || !strings.Contains(patches[0].card, "你已同意") || strings.Contains(patches[0].card, `"op":"accept"`) {
		t.Fatalf("the card became %+v, want it settled without buttons", patches)
	}

	// The assistant's next turn, which Feishu did not start, is told in the
	// topic.
	f.manager.SessionEnded(store.AgentSession{ID: "sess_1", Status: "completed", Response: "first answer"})
	f.manager.SessionEnded(store.AgentSession{ID: "sess_1", Status: "completed", Response: "archived it"})
	if !repliesContain(f.bot.take(), "om_topic", "archived it") {
		t.Fatal("the turn after the approval was not told in the topic")
	}
}

// A proposal from a conversation outside Feishu goes to the person's direct
// chat with the assistant; a yes at the chat's top level answers it.
func TestProposalFromTheWebReachesTheDirectChat(t *testing.T) {
	ctx := context.Background()
	f := newAssistantFixture(t)
	proposal := store.PersonalAgentProposal{ID: "pap_web", UserID: f.person.ID, SessionID: "sess_web", Summary: "把你的飞书接到『记账』", Status: store.PersonalAgentProposalPending}
	f.desk.set(func(a *fakeAssistant) { a.pending = []store.PersonalAgentProposal{proposal} })
	f.manager.postProposal(ctx, proposal)
	f.bot.mu.Lock()
	sent := append([]struct{ to, card string }(nil), f.bot.sent...)
	f.bot.mu.Unlock()
	if len(sent) != 1 || sent[0].to != "oc_dm" || !strings.Contains(sent[0].card, "pap_web") {
		t.Fatalf("sent %+v, want the card in the direct chat", sent)
	}
	f.send(t, personMessage("om_no", "", "算了", "ou_person"))
	if len(f.desk.decisions) != 1 || f.desk.decisions[0] != "declined pap_web via reply" || len(f.started()) != 0 {
		t.Fatalf("decisions %v, started %d, want pap_web declined before the model", f.desk.decisions, len(f.started()))
	}
	if patches := f.bot.takePatches(); len(patches) != 1 || patches[0].to != "card_sent_1" || !strings.Contains(patches[0].card, "你没有同意") {
		t.Fatalf("the card became %+v, want it settled", patches)
	}
}

// The assistant answers no group: a group cannot pair with its workspace.
func TestAGroupCannotPairWithTheAssistant(t *testing.T) {
	ctx := context.Background()
	f := newAssistantFixture(t)
	runBotOn(t, f.db, "ws_pa", "cli_x")
	issueCode(t, f.db, "ws_pa", "FND-PAPA", f.person.ID)
	group := groupMessage("om_pair", "", "@_user_1 /pair FND-PAPA", true)
	chat := "oc_new_group"
	group.Event.Message.ChatId = &chat
	f.send(t, group)
	if _, err := f.db.FindFeishuChatRoute(ctx, "cli_x", "oc_new_group"); err == nil {
		t.Fatal("a group paired with the assistant's workspace")
	}
	if !repliesContain(f.bot.take(), "om_pair", "助理只在单聊里回答") {
		t.Fatal("the group was not told why")
	}
}

// The assistant's workspace lists the direct chats it takes, marked with
// it; the group stays its workspace's alone.
func TestAssistantWorkspaceListsTheDirectChatsItTakes(t *testing.T) {
	ctx := context.Background()
	f := newAssistantFixture(t)
	view, err := f.manager.WorkspaceBot(ctx, "ws_pa")
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Chats) != 1 || view.Chats[0].ChatID != "oc_dm" || view.Chats[0].WorkspaceID != "ws_1" || view.Chats[0].AssistantWorkspaceID != "ws_pa" {
		t.Fatalf("the assistant's chats = %+v", view.Chats)
	}
	routes, err := f.db.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: "ws_1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		marked := f.manager.withAssistant(ctx, route).AssistantWorkspaceID
		if (route.ChatID == "oc_dm") != (marked == "ws_pa") {
			t.Errorf("%s %s marked %q", route.Kind, route.ChatID, marked)
		}
	}
	f.desk.set(func(a *fakeAssistant) { a.route.TakesDirectChats = false })
	if view, _ := f.manager.WorkspaceBot(ctx, "ws_pa"); len(view.Chats) != 0 {
		t.Fatalf("with direct chats left to their projects the assistant lists %+v", view.Chats)
	}
}

// With no language chosen, the server answers in the language the person
// writes in; a chosen language wins over it, also on proposal cards.
func TestAssistantAnswersInThePersonsLanguage(t *testing.T) {
	ctx := context.Background()
	f := newAssistantFixture(t)

	f.send(t, personMessage("om_stop_zh", "", "停", "ou_person"))
	replies := f.bot.take()
	if !repliesContain(replies, "om_stop_zh", "停了 2 件正在做的事") || !repliesContain(replies, "om_stop_zh", "继续") {
		t.Fatalf("a Chinese stop was answered %+v, want Chinese", replies)
	}
	f.send(t, personMessage("om_resume_en", "", "resume", "ou_person"))
	if replies := f.bot.take(); !repliesContain(replies, "om_resume_en", "I'm back") || repliesContain(replies, "om_resume_en", "已恢复") {
		t.Fatalf("an English resume was answered %+v, want English", replies)
	}

	f.desk.set(func(a *fakeAssistant) {
		a.language, a.route.HomeOffline, a.route.SettingsURL = "en", true, "https://foundry.test/assistant"
	})
	f.send(t, personMessage("om_offline", "", "帮我做个页面", "ou_person"))
	replies = f.bot.take()
	if !repliesContain(replies, "om_offline", "The computer I run on is offline") || !repliesContain(replies, "om_offline", "move me to another computer") {
		t.Fatalf("with English chosen, a Chinese message was answered %+v, want English", replies)
	}
	f.desk.set(func(a *fakeAssistant) { a.route.HomeOffline = false })
	f.send(t, personMessage("om_stop_en", "", "停", "ou_person"))
	replies = f.bot.take()
	if !repliesContain(replies, "om_stop_en", "Everything is stopped") || !repliesContain(replies, "om_stop_en", `"content":"Resume"`) {
		t.Fatalf("with English chosen, the stop was answered %+v, want English with a Resume button", replies)
	}
	f.send(t, personMessage("om_resume_zh", "", "继续", "ou_person"))
	f.bot.take()

	f.send(t, personMessage("om_topic", "", "archive the old blog", "ou_person"))
	f.bot.take()
	proposal := store.PersonalAgentProposal{ID: "pap_en", UserID: f.person.ID, SessionID: "sess_1", Summary: "Shall I put “Old blog” away?", Status: store.PersonalAgentProposalPending}
	f.desk.set(func(a *fakeAssistant) { a.pending = []store.PersonalAgentProposal{proposal} })
	f.manager.postProposal(ctx, proposal)
	if replies := f.bot.take(); len(replies) != 1 || !strings.Contains(replies[0].card, "Needs your OK") || !strings.Contains(replies[0].card, "No thanks") {
		t.Fatalf("the English proposal was posted %+v, want an English card", replies)
	}
	f.send(t, personMessage("om_yes", "om_topic", "好", "ou_person"))
	if patches := f.bot.takePatches(); len(patches) != 1 || !strings.Contains(patches[0].card, "You said yes") {
		t.Fatalf("the accepted card became %+v, want English", patches)
	}

	f.desk.set(func(a *fakeAssistant) { a.language, a.route.HomeOffline = "zh", true })
	f.send(t, personMessage("om_offline_zh", "", "make me a page", "ou_person"))
	if replies := f.bot.take(); !repliesContain(replies, "om_offline_zh", "助理所在的电脑现在不在线") {
		t.Fatalf("with Chinese chosen, an English message was answered %+v, want Chinese", replies)
	}
}
