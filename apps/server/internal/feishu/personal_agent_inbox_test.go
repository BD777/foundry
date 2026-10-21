package feishu

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type inboxTestDesk struct {
	*fakeAssistant
	db *sqlitestore.Store
}

func (d inboxTestDesk) CaptureInbox(ctx context.Context, userID, text string, origin store.PersonalAgentInboxOrigin) (store.PersonalAgentInboxEntry, error) {
	return d.db.CapturePersonalAgentInbox(ctx, store.PersonalAgentInboxEntry{
		ID: "inbox_" + origin.MessageID, UserID: userID, Channel: "feishu", MessageID: origin.AppID + ":" + origin.MessageID,
		Text: text, InputID: store.WorkRunInputID(userID, origin.MessageID), Origin: &origin, Timezone: "Asia/Shanghai",
	})
}

type inboxTestDispatcher struct{ *recordingDispatcher }

func (d inboxTestDispatcher) SaveInboxAttachments(ctx context.Context, workspaceID, _ string, files []MessageFile) ([]store.ChatAttachment, error) {
	return d.SaveAttachments(ctx, workspaceID, files)
}

func TestAssistantInboxKeepsOfflineInputOnceAndRejectsOtherSender(t *testing.T) {
	f := newAssistantFixture(t)
	f.manager.PersonalAgents = inboxTestDesk{f.desk, f.db}
	f.desk.route.HomeOffline = true
	f.desk.route.Stopped = true
	message := personMessage("om_capture", "", "Remember the synthetic export task", "ou_person")
	f.send(t, message)
	entries, err := f.db.ListPersonalAgentInbox(context.Background(), f.person.ID, 10)
	if err != nil || len(entries) != 1 || entries[0].Origin.ChatID != "oc_dm" || entries[0].Origin.MessageID != "om_capture" {
		t.Fatalf("source not retained: %+v %v", entries, err)
	}
	if len(f.started()) != 0 {
		t.Fatal("capture started a model while offline or stopped")
	}
	if replies := f.bot.take(); len(replies) != 1 {
		t.Fatalf("capture acknowledgement: %+v", replies)
	}
	f.send(t, message)
	if replies := f.bot.take(); len(replies) != 0 {
		t.Fatalf("replay created another card: %+v", replies)
	}
	f.send(t, personMessage("om_stranger", "", "Run an unrelated task", "ou_other"))
	entries, _ = f.db.ListPersonalAgentInbox(context.Background(), f.person.ID, 10)
	if len(entries) != 1 || len(f.started()) != 0 {
		t.Fatal("another sender acquired the person's authority")
	}
}

func TestAssistantInboxDoesNotDropMissingAttachmentsOrMisrouteResult(t *testing.T) {
	f := newAssistantFixture(t)
	f.manager.PersonalAgents = inboxTestDesk{f.desk, f.db}
	f.manager.dispatcher = inboxTestDispatcher{f.dispatcher}
	ctx := context.Background()
	origin := store.PersonalAgentInboxOrigin{AppID: "cli_x", ChatID: "oc_dm", MessageID: "om_files", Resources: []store.PersonalAgentInboxResource{
		{Key: "first", Type: "file", Name: "first.txt", Label: "file"},
		{Key: "second", Type: "file", Name: "second.txt", Label: "file"},
	}}
	entry, err := f.manager.PersonalAgents.(PersonalAgentInboxDesk).CaptureInbox(ctx, f.person.ID, "Compare both files", origin)
	if err != nil {
		t.Fatal(err)
	}
	f.bot.files = map[string]MessageFile{"first": {Name: "first.txt", Data: []byte("one")}}
	if _, _, err := f.manager.PrepareAssistantInbox(ctx, entry, "ws_pa"); err == nil {
		t.Fatal("a partial attachment set was dispatched")
	}
	if len(f.dispatcher.saved) != 0 {
		t.Fatal("partial downloads were written before all resources were ready")
	}
	f.bot.files["second"] = MessageFile{Name: "second.txt", Data: []byte("two")}
	text, files, err := f.manager.PrepareAssistantInbox(ctx, entry, "ws_pa")
	if err != nil || text != entry.Text || len(files) != 2 {
		t.Fatalf("prepare: %s %+v %v", text, files, err)
	}
	if err := f.manager.FollowAssistantInbox(ctx, entry, "ws_pa", "session-one"); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.FollowAssistantInbox(ctx, entry, "ws_pa", "session-one"); err != nil {
		t.Fatal(err)
	}
	if replies := f.bot.take(); len(replies) != 1 {
		t.Fatalf("follow repeated a card: %+v", replies)
	}
	entry.SessionID, entry.ResultStatus, entry.ResultText = "session-one", "completed", "Synthetic result"
	if err := f.manager.DeliverAssistantInboxResult(ctx, entry, "ws_pa", "https://example.invalid/result"); err != nil {
		t.Fatal(err)
	}
	patches := f.bot.takePatches()
	if len(patches) != 1 || patches[0].to != "card_om_files" {
		t.Fatalf("result went to another input: %+v", patches)
	}
	entry.UserID = "someone-else"
	if _, _, err := f.manager.PrepareAssistantInbox(ctx, entry, "ws_pa"); err == nil {
		t.Fatal("changed channel owner could read the resources")
	}
}
