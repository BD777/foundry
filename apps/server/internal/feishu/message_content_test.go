package feishu

import (
	"context"
	"reflect"
	"strings"
	"testing"

	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Contents as Feishu's "receive message content" documents them, per
// message_type.
func TestParseMessageNamesEveryContentType(t *testing.T) {
	tests := []struct {
		name, messageType, content string
		text                       string
		resources                  []messageResource
	}{
		{name: "text with mentions", messageType: "text", content: `{"text":"@_user_1 @_user_2 hello world"}`, text: "hello world"},
		{name: "text pairing", messageType: "text", content: `{"text":"@_user_1 /pair FND-CFTY"}`, text: "/pair FND-CFTY"},
		{
			name: "post with images and a video", messageType: "post",
			content: `{"title":"我是一个标题","content":[[{"tag":"at","user_id":"@_user_1","user_name":"Foundry","style":[]},{"tag":"text","text":" 第一行 :","style":["bold"]},{"tag":"a","href":"http://www.feishu.cn","text":"超链接","style":[]}],[{"tag":"img","image_key":"img_v2_one"}],[{"tag":"text","text":"看这里","style":[]},{"tag":"img","image_key":"img_v2_two"}],[{"tag":"media","file_key":"file_v2_clip","image_key":"img_v2_cover"}],[{"tag":"emotion","emoji_type":"SMILE"}],[{"tag":"hr"}],[{"tag":"code_block","language":"GO","text":"func main() int64 {\n    return 0\n}\n"}]]}`,
			text:    "我是一个标题\n第一行 :超链接\n[image]\n看这里[image]\n[video]\nfunc main() int64 {\n    return 0\n}",
			resources: []messageResource{
				{key: "img_v2_one", resourceType: "image", label: "image"},
				{key: "img_v2_two", resourceType: "image", label: "image"},
				{key: "file_v2_clip", resourceType: "file", label: "video"},
			},
		},
		{
			name: "post in one locale", messageType: "post",
			content: `{"zh_cn":{"title":"任务标题","content":[[{"tag":"at","user_id":"ou_1","user_name":"Foundry"},{"tag":"text","text":" 请帮我审查代码"}]]}}`,
			text:    "任务标题\n请帮我审查代码",
		},
		{
			name: "image", messageType: "image", content: `{"image_key":"img_v2_041b28e3-5680-48c2-9af2-497ace79333g"}`, text: "[image]",
			resources: []messageResource{{key: "img_v2_041b28e3-5680-48c2-9af2-497ace79333g", resourceType: "image", label: "image"}},
		},
		{
			name: "file", messageType: "file", content: `{"file_key":"file_v2_0dcbf4ec-fd2a-4f5f-b5b0-3b4eb33e4ccg","file_name":"测试文件.txt"}`, text: "[file: 测试文件.txt]",
			resources: []messageResource{{key: "file_v2_0dcbf4ec-fd2a-4f5f-b5b0-3b4eb33e4ccg", resourceType: "file", name: "测试文件.txt", label: "file"}},
		},
		{
			name: "audio", messageType: "audio", content: `{"file_key":"file_v2_voice","duration":2000}`, text: "[audio]",
			resources: []messageResource{{key: "file_v2_voice", resourceType: "file", label: "audio"}},
		},
		{
			name: "media", messageType: "media", content: `{"file_key":"file_v2_movie","image_key":"img_v2_cover","file_name":"测试视频.mp4","duration":2000}`, text: "[video: 测试视频.mp4]",
			resources: []messageResource{{key: "file_v2_movie", resourceType: "file", name: "测试视频.mp4", label: "video"}},
		},
		{name: "sticker", messageType: "sticker", content: `{"file_key":"v2_sticker"}`, text: "[sticker]"},
		{name: "shared chat", messageType: "share_chat", content: `{"chat_id":"oc_0dd200d32fda15216d2c2ef1ddb32f76"}`, text: "[share_chat]"},
		{name: "image without its key", messageType: "image", content: `{}`, text: "[image]"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseMessage(tc.messageType, tc.content)
			if text := cleanLeadingMentions(got.text); text != tc.text {
				t.Errorf("text = %q, want %q", text, tc.text)
			}
			if !reflect.DeepEqual(got.resources, tc.resources) {
				t.Errorf("resources = %+v, want %+v", got.resources, tc.resources)
			}
			if strings.Contains(got.text, `":`) {
				t.Errorf("text %q passes the content's JSON on", got.text)
			}
		})
	}
}

func directMessage(id, root, messageType, content string) *larkim.P2MessageReceiveV1 {
	message := groupMessage(id, root, "", false)
	chat, kind := "oc_dm", "p2p"
	message.Event.Message.ChatId, message.Event.Message.ChatType = &chat, &kind
	message.Event.Message.MessageType, message.Event.Message.Content = &messageType, &content
	return message
}

// An image alone starts a topic: the bot downloads it and the session gets
// it as an attachment, with a prompt saying an image was sent. A file the
// bot cannot download is said in the prompt, never dropped silently.
func TestAMessageBringsItsFilesToTheSession(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	member := addUser(t, db, "member", store.WorkspaceRoleMember)
	bindChat(t, db, "ws_1", "cli_x", "oc_dm", store.FeishuRouteP2P, member.ID)
	dispatcher := &recordingDispatcher{}
	manager := NewWSManager(db, allSecrets{}, dispatcher, eventsForTest())
	bot := &fakeBot{files: map[string]MessageFile{
		"img_v2_shot": {Name: "", MIMEType: "image/png", Data: []byte("png")},
		"img_v2_one":  {Name: "one.jpg", MIMEType: "image/jpeg", Data: []byte("jpg")},
	}}
	app := &botApp{clientID: "cli_x", client: bot}

	if err := manager.handleMessage(ctx, app, directMessage("om_img", "", "image", `{"image_key":"img_v2_shot"}`)); err != nil {
		t.Fatal(err)
	}
	if len(dispatcher.started) != 1 {
		t.Fatalf("an image alone started %d sessions, want 1", len(dispatcher.started))
	}
	started := dispatcher.started[0]
	if started.Prompt != "[image]" || len(started.Attachments) != 1 || started.Attachments[0].Name != "image" || started.Attachments[0].MIMEType != "image/png" {
		t.Fatalf("started %q with %+v, want [image] with the image attached", started.Prompt, started.Attachments)
	}
	if want := []string{"om_img/img_v2_shot?type=image"}; !reflect.DeepEqual(bot.downloads, want) {
		t.Fatalf("downloaded %v, want %v", bot.downloads, want)
	}

	post := `{"title":"","content":[[{"tag":"text","text":"compare these"}],[{"tag":"img","image_key":"img_v2_one"}],[{"tag":"img","image_key":"img_v2_gone"}]]}`
	if err := manager.handleMessage(ctx, app, directMessage("om_post", "", "post", post)); err != nil {
		t.Fatal(err)
	}
	second := dispatcher.started[1]
	if len(second.Attachments) != 1 || second.Attachments[0].Name != "one.jpg" {
		t.Fatalf("the post attached %+v, want its one downloadable image", second.Attachments)
	}
	if !strings.HasPrefix(second.Prompt, "compare these\n[image]\n[image]\n") || !strings.Contains(second.Prompt, "([image] could not be downloaded from Feishu") {
		t.Fatalf("the post's prompt is %q, want its text, both images marked, and why one is missing", second.Prompt)
	}

	if err := manager.handleMessage(ctx, app, directMessage("om_sticker", "", "sticker", `{"file_key":"v2_sticker"}`)); err != nil {
		t.Fatal(err)
	}
	if third := dispatcher.started[2]; third.Prompt != "[sticker]" || len(third.Attachments) != 0 {
		t.Fatalf("a sticker started %q with %+v, want [sticker] and nothing attached", third.Prompt, third.Attachments)
	}
}

// sessionRecords is the real store with one session in it.
type sessionRecords struct {
	*sqlitestore.Store
	session store.AgentSession
}

func (s sessionRecords) GetAgentSessionRecord(context.Context, string) (store.AgentSession, error) {
	return s.session, nil
}

// A file sent in a topic's thread steers its running session with the file.
func TestAFileInATopicSteersItsSession(t *testing.T) {
	ctx := context.Background()
	db := openPairingTestStore(t)
	member := addUser(t, db, "member", store.WorkspaceRoleMember)
	bindChat(t, db, "ws_1", "cli_x", "oc_dm", store.FeishuRouteP2P, member.ID)
	if err := db.SaveFeishuChatThread(ctx, store.FeishuChatThread{RootMessageID: "om_root", WorkspaceID: "ws_1", ChatID: "oc_dm", LatestSessionID: "sess_1", CardMessageID: "card_root"}); err != nil {
		t.Fatal(err)
	}
	dispatcher := &recordingDispatcher{}
	manager := NewWSManager(sessionRecords{db, store.AgentSession{ID: "sess_1", WorkspaceID: "ws_1", Status: "running"}}, allSecrets{}, dispatcher, eventsForTest())
	bot := &fakeBot{files: map[string]MessageFile{"file_v2_log": {Name: "server.log", MIMEType: "text/plain", Data: []byte("boom")}}}
	app := &botApp{clientID: "cli_x", client: bot}

	if err := manager.handleMessage(ctx, app, directMessage("om_file", "om_root", "file", `{"file_key":"file_v2_log","file_name":"server.log"}`)); err != nil {
		t.Fatal(err)
	}
	if len(dispatcher.started) != 0 || len(dispatcher.sent) != 1 {
		t.Fatalf("started %d and sent %d, want the file sent to the topic's session", len(dispatcher.started), len(dispatcher.sent))
	}
	sent := dispatcher.sent[0]
	if sent.sessionID != "sess_1" || sent.text != "[file: server.log]" || len(sent.attachments) != 1 || sent.attachments[0].Name != "server.log" {
		t.Fatalf("sent %+v, want server.log to sess_1", sent)
	}
	if want := []string{"om_file/file_v2_log?type=file"}; !reflect.DeepEqual(bot.downloads, want) {
		t.Fatalf("downloaded %v, want %v", bot.downloads, want)
	}
}
