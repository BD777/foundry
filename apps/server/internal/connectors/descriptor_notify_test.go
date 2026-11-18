package connectors

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func notifyDescriptor() store.ConnectorDescriptor {
	descriptor := ackDescriptor()
	descriptor.ServerHeld.Fields = append(descriptor.ServerHeld.Fields, store.ConnectorField{ID: "notifyChat", Type: "text", Label: "Notice chat"})
	descriptor.ServerHeld.Steps[1] = append(descriptor.ServerHeld.Steps[1], "notifyChat")
	descriptor.ServerHeld.Events.Envelope.Fields["attributes.replyTo"] = store.ConnectorEventsValue{Pointer: "/replyTo"}
	descriptor.ServerHeld.Notify = &store.ConnectorServerHeldNotify{
		Version: 1,
		Format:  "markdown",
		Target:  store.ConnectorServerHeldNotifyTarget{Field: "notifyChat", ConversationKind: "self"},
		Send: store.ConnectorServerHeldNotifySend{
			Method: "POST",
			Path:   "/api/conversations/{target}/messages",
			Body:   `{"clientId":"{notice.id}","editorType":"markdown","text":"{text|json}\n\n[Open]({link|json})"}`,
		},
		Sent:    store.ConnectorServerHeldNotifySent{MessageID: "/message/id"},
		ReplyTo: "attributes.replyTo",
	}
	return descriptor
}

// openLarkDescriptor reads the bundled open-lark manifest the way the Worker
// reports it to the server, so the tests check the shipped descriptor itself.
func openLarkDescriptor(t *testing.T) store.ConnectorDescriptor {
	t.Helper()
	data, err := os.ReadFile("../../../../extensions/open-lark/foundry-extension.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		ID         string                      `json:"id"`
		Name       string                      `json:"name"`
		Version    string                      `json:"version"`
		Connectors []store.ConnectorDescriptor `json:"connectors"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	descriptor := manifest.Connectors[0]
	descriptor.Adapter = "extension:" + manifest.ID
	descriptor.Extension = &store.ConnectorExtensionSource{ID: manifest.ID, Name: manifest.Name, Version: manifest.Version}
	descriptor.Holding = store.ConnectorServerHeld
	if descriptor.Tool.Source == "" {
		descriptor.Tool.Source = "device"
	}
	return descriptor
}

func TestDescriptorChecksTheNotifySection(t *testing.T) {
	if err := checkDescriptor(notifyDescriptor()); err != nil {
		t.Fatalf("a valid notify section: %v", err)
	}
	cases := []struct {
		name   string
		change func(*store.ConnectorServerHeldNotify)
		want   string
	}{
		{"version 2 is refused", func(n *store.ConnectorServerHeldNotify) { n.Version = 2 }, "this Foundry is too old for notify version 2"},
		{"version 0 is refused", func(n *store.ConnectorServerHeldNotify) { n.Version = 0 }, "notify.version is 1"},
		{"format is markdown", func(n *store.ConnectorServerHeldNotify) { n.Format = "html" }, "notify.format is markdown"},
		{"target is self", func(n *store.ConnectorServerHeldNotify) { n.Target.ConversationKind = "group" }, "conversationKind is self"},
		{"target names a text field", func(n *store.ConnectorServerHeldNotify) { n.Target.Field = "readToken" }, "names a text field"},
		{"send is a write request", func(n *store.ConnectorServerHeldNotify) { n.Send.Method = "GET" }, "send.method is a write method"},
		{"send path stays under the prefix", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Path = "/other/{target}/messages"
		}, "send.path must be at or below the upstream prefix"},
		{"send path names the target", func(n *store.ConnectorServerHeldNotify) { n.Send.Path = "/api/conversations/x/messages" }, "must use {target}"},
		{"send path uses only its values", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Path = "/api/conversations/{target}/{feedId}/messages"
		}, "send.path may only use"},
		{"send path has no |json", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Path = "/api/conversations/{target|json}/messages"
		}, "only for a body"},
		{"send body needs the target's value kinds", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Body = strings.Replace(n.Send.Body, "{notice.id}", "{feedId}", 1)
		}, "send.body may only use"},
		{"body text without json is refused", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Body = strings.Replace(n.Send.Body, "{text|json}", "{text}", 1)
		}, "{text} needs |json in a body"},
		{"body link without json is refused", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Body = strings.Replace(n.Send.Body, "{link|json}", "{link}", 1)
		}, "{link} needs |json in a body"},
		{"body names the notice text", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Body = `{"clientId":"{notice.id}"}`
		}, "must use {text|json}"},
		{"body is JSON once filled", func(n *store.ConnectorServerHeldNotify) {
			n.Send.Body = `{"text":{text|json}}`
		}, "must be JSON"},
		{"body is required", func(n *store.ConnectorServerHeldNotify) { n.Send.Body = "" }, "send.body is required"},
		{"sent id is a JSON pointer", func(n *store.ConnectorServerHeldNotify) { n.Sent.MessageID = "message/id" }, "sent.messageId is a JSON pointer"},
		{"sent id is required", func(n *store.ConnectorServerHeldNotify) { n.Sent.MessageID = "" }, "sent.messageId is a JSON pointer"},
		{"replyTo is an envelope field", func(n *store.ConnectorServerHeldNotify) { n.ReplyTo = "attributes.nope" }, "not an events envelope field"},
	}
	for _, c := range cases {
		descriptor := notifyDescriptor()
		c.change(descriptor.ServerHeld.Notify)
		err := checkDescriptor(descriptor)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.name, err, c.want)
		}
	}
}

func TestDescriptorChecksNotifyReplyToNeedsEvents(t *testing.T) {
	descriptor := notifyDescriptor()
	descriptor.ServerHeld.Events = nil
	err := checkDescriptor(descriptor)
	if err == nil || !strings.Contains(err.Error(), "needs serverHeld.events") {
		t.Fatalf("replyTo without events: %v", err)
	}
}

func TestOpenLarkDescriptorDeclaresNotifyAndPassesChecks(t *testing.T) {
	descriptor := openLarkDescriptor(t)
	if descriptor.ServerHeld == nil || descriptor.ServerHeld.Notify == nil {
		t.Fatal("open-lark declares no notify section")
	}
	if err := checkDescriptor(descriptor); err != nil {
		t.Fatalf("open-lark descriptor: %v", err)
	}
	var notifyField bool
	for _, field := range descriptor.ServerHeld.Fields {
		notifyField = notifyField || (field.ID == "notifyChat" && field.Type == "text" && !field.Required)
	}
	if !notifyField {
		t.Fatal("open-lark declares no optional text field notifyChat")
	}
}

func TestOpenLarkNotifyBodyKeepsTheNoticeTextAsJSON(t *testing.T) {
	body := openLarkDescriptor(t).ServerHeld.Notify.Send.Body
	text := "Question: \"ship\" or \"wait\"?\nline two \\ back\\slash\n中文 `code` *bold*"
	link := "https://foundry.example/items/abc?x=1&y=2"
	filled, err := FillRequestTemplate(body, map[string]string{"notice.id": "notice-1", "text": text, "link": link}, true)
	if err != nil {
		t.Fatal(err)
	}
	var message struct {
		ClientID   string `json:"clientId"`
		EditorType string `json:"editorType"`
		Text       string `json:"text"`
	}
	if err := json.Unmarshal([]byte(filled), &message); err != nil {
		t.Fatalf("filled body is not JSON: %v\n%s", err, filled)
	}
	if message.ClientID != "notice-1" || message.EditorType != "markdown" {
		t.Errorf("clientId and editorType: %+v", message)
	}
	if want := text + "\n\n[在 Foundry 中处理](" + link + ")"; message.Text != want {
		t.Errorf("text = %q, want %q", message.Text, want)
	}
}
