package feishu

import (
	"context"
	"strings"
	"sync"
	"testing"

	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fakeBot records the cards a bot would send.
type fakeBot struct {
	mu      sync.Mutex
	replies []struct{ to, card string }
}

func (b *fakeBot) ReplyCard(_ context.Context, messageID, card string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.replies = append(b.replies, struct{ to, card string }{messageID, card})
	return "card_" + messageID, nil
}
func (b *fakeBot) PatchCard(context.Context, string, string) error     { return nil }
func (b *fakeBot) GetChatInfo(context.Context, string) (string, error) { return "Group", nil }
func (b *fakeBot) take() []struct{ to, card string } {
	b.mu.Lock()
	defer b.mu.Unlock()
	r := b.replies
	b.replies = nil
	return r
}

// fakeDesk stands in for the server's Issue workflow.
type fakeDesk struct {
	issue    store.Issue
	messages []string
	confirms int
}

func (d *fakeDesk) CreateSessionAndDispatch(context.Context, store.CreateAgentSessionInput) (store.AgentSession, error) {
	return store.AgentSession{}, nil
}
func (d *fakeDesk) SendSessionMessage(context.Context, string, string) error { return nil }
func (d *fakeDesk) PublishEvent(string, any)                                 {}
func (d *fakeDesk) StartIssue(_ context.Context, workspaceID, userID, goal string) (store.Issue, error) {
	d.issue.WorkspaceID, d.issue.SourceInput, d.issue.CreatedByUserID = workspaceID, goal, userID
	return d.issue, nil
}
func (d *fakeDesk) IssueMessage(_ context.Context, issueID, _, text string) (string, error) {
	d.messages = append(d.messages, issueID+": "+text)
	return "已转给澄清 Agent", nil
}
func (d *fakeDesk) ConfirmIssue(context.Context, string, string) (string, error) {
	d.confirms++
	return "已确认", nil
}
func (d *fakeDesk) IssueURL(issue store.Issue) string {
	return "https://foundry.example/issues/" + issue.ID
}

// issueStore is the real store with the Issue under test in place of stored ones.
type issueStore struct {
	*sqlitestore.Store
	issue *store.Issue
}

func (s issueStore) GetIssue(context.Context, string) (store.Issue, error) { return *s.issue, nil }

func groupMessage(id, root, text string, mention bool) *larkim.P2MessageReceiveV1 {
	chat, kind, content := "oc_1", "text", `{"text":"`+text+`"}`
	message := &larkim.EventMessage{MessageId: &id, ChatId: &chat, MessageType: &kind, Content: &content}
	if root != "" {
		message.RootId = &root
	}
	if mention {
		key := "@_user_1"
		message.Mentions = []*larkim.MentionEvent{{Key: &key}}
	}
	sender := "user"
	return &larkim.P2MessageReceiveV1{Event: &larkim.P2MessageReceiveV1Data{Sender: &larkim.EventSender{SenderType: &sender}, Message: message}}
}

func TestAGroupThreadFollowsAnIssue(t *testing.T) {
	db := openPairingTestStore(t)
	ctx := context.Background()
	member := addUser(t, db, "member", store.WorkspaceRoleMember)
	bindGroup(t, db, member.ID)
	draft := 1
	desk := &fakeDesk{issue: store.Issue{ID: "iss_1", ShortID: "ISS-1", Title: "Add usage", Status: "pending", ContractState: "draft", DraftContractRevision: &draft,
		Messages: []store.IssueConversationMessage{{ID: "clarify_u1", Role: "user", Text: "Add usage"}}}}
	current := desk.issue
	manager := NewWSManager(issueStore{db, &current}, nil, desk)
	bot := &fakeBot{}
	manager.activeBots["ws_1"] = &activeBot{workspaceID: "ws_1", client: bot}

	if err := manager.handleMessage(ctx, "ws_1", bot, groupMessage("om_root", "", "@_user_1 /issue Add usage to the README", true)); err != nil {
		t.Fatal(err)
	}
	if desk.issue.SourceInput != "Add usage to the README" || desk.issue.CreatedByUserID != member.ID {
		t.Fatalf("/issue did not start the Issue as the bound account: %+v", desk.issue)
	}
	thread, err := db.GetFeishuChatThread(ctx, "om_root")
	if err != nil || thread.IssueID != "iss_1" {
		t.Fatalf("the thread does not follow the Issue: %+v %v", thread, err)
	}
	if replies := bot.take(); len(replies) != 1 || !strings.Contains(replies[0].card, "ISS-1") || !strings.Contains(replies[0].card, "foundry.example/issues/iss_1") {
		t.Fatalf("no Issue card with its link: %+v", replies)
	}

	// Replies in the thread go to the Issue without another @; /confirm confirms.
	if err := manager.handleMessage(ctx, "ws_1", bot, groupMessage("om_2", "om_root", "It is for new users", false)); err != nil {
		t.Fatal(err)
	}
	if err := manager.handleMessage(ctx, "ws_1", bot, groupMessage("om_3", "om_root", "/confirm", false)); err != nil {
		t.Fatal(err)
	}
	if len(desk.messages) != 1 || desk.messages[0] != "iss_1: It is for new users" || desk.confirms != 1 {
		t.Fatalf("thread replies were not routed to the Issue: %v, %d confirms", desk.messages, desk.confirms)
	}
	bot.take()

	// What happens to the Issue is reported to the thread, once.
	issue := &current
	issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: "clarify_a1", Role: "assistant", Text: "Which file should hold the usage?"})
	draft2 := 2
	issue.DraftContractRevision = &draft2
	manager.reportIssue(ctx, issue.ID)
	manager.reportIssue(ctx, issue.ID)
	cards := bot.take()
	if len(cards) != 2 || cards[0].to != "om_root" || !strings.Contains(cards[0].card, "Which file should hold the usage?") || !strings.Contains(cards[1].card, "/confirm") {
		t.Fatalf("reports = %+v", cards)
	}
	issue.Status = "blocked"
	issue.Question = &store.IssueQuestion{ID: "question_1", Kind: "permission", Text: "Create docs/USAGE.md?", Options: []string{"Yes", "No"}}
	issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: "question_1", Role: "assistant", Text: "Create docs/USAGE.md?"})
	manager.reportIssue(ctx, issue.ID)
	cards = bot.take()
	if len(cards) != 1 || !strings.Contains(cards[0].card, "许可") || !strings.Contains(cards[0].card, "Create docs/USAGE.md?") {
		t.Fatalf("question report = %+v", cards)
	}
	issue.Status, issue.Question = "verifying", nil
	manager.reportIssue(ctx, issue.ID)
	cards = bot.take()
	if len(cards) != 1 || !strings.Contains(cards[0].card, "等待验收") || !strings.Contains(cards[0].card, "foundry.example/issues/iss_1") {
		t.Fatalf("verifying report = %+v", cards)
	}
}
