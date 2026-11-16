package connectors

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func ackDescriptor() store.ConnectorDescriptor {
	descriptor := acmeExtensionDescriptor()
	descriptor.ServerHeld.Events = &store.ConnectorEventsSpec{
		Poll: store.ConnectorEventsPoll{Path: "/api/changes", Cursor: "/cursor", Items: "/items"},
		Envelope: store.ConnectorEventsEnvelope{Fields: map[string]store.ConnectorEventsValue{
			"id": {Pointer: "/id"},
		}},
		Ack: &store.ConnectorEventsAck{
			Reaction: "OnIt",
			Add:      store.ConnectorEventsAckCall{Method: "POST", Path: "/api/messages/{message.id}/reactions", Body: `{"key":"{reaction}"}`},
			Remove:   store.ConnectorEventsAckCall{Method: "DELETE", Path: "/api/messages/{message.id}/reactions/{reaction}"},
		},
	}
	descriptor.ServerHeld.Writes = []store.ConnectorServerHeldWrite{{
		Method: "POST", Path: "/api/messages/:messageId/replies", CreatedMessageID: "/messageId",
		Footer: &store.ConnectorServerHeldWriteFooter{
			Text: "/text", Markdown: true,
			Format: &store.ConnectorServerHeldWriteFooterFormat{
				Field: "/editorType", Value: "markdown", Plain: []string{"simple"},
				Escape: store.ConnectorServerHeldWriteFooterFormatEscapeMarkdown,
			},
		},
	}}
	return descriptor
}

func TestDescriptorChecksTheAcknowledgementAndFooter(t *testing.T) {
	if err := checkDescriptor(ackDescriptor()); err != nil {
		t.Fatalf("a valid ack and footer: %v", err)
	}
	cases := []struct {
		name   string
		change func(*store.ConnectorDescriptor)
		want   string
	}{
		{"ack reaction is one key", func(d *store.ConnectorDescriptor) { d.ServerHeld.Events.Ack.Reaction = "" }, "ack.reaction"},
		{"ack add is a write request", func(d *store.ConnectorDescriptor) { d.ServerHeld.Events.Ack.Add.Method = "GET" }, "ack.add.method"},
		{"ack path stays under the prefix", func(d *store.ConnectorDescriptor) { d.ServerHeld.Events.Ack.Add.Path = "/other/reactions" }, "ack.add.path"},
		{"ack path uses only its two values", func(d *store.ConnectorDescriptor) { d.ServerHeld.Events.Ack.Remove.Path = "/api/{feedId}" }, "ack.remove.path"},
		{"ack body is JSON", func(d *store.ConnectorDescriptor) { d.ServerHeld.Events.Ack.Add.Body = `{"key":` }, "ack.add.body"},
		{"footer names a body field", func(d *store.ConnectorDescriptor) { d.ServerHeld.Writes[0].Footer.Text = "text" }, "writes.footer.text"},
		{"footer format is markdown", func(d *store.ConnectorDescriptor) { d.ServerHeld.Writes[0].Footer.Markdown = false }, "writes.footer.format requires"},
		{"footer format names a body field", func(d *store.ConnectorDescriptor) { d.ServerHeld.Writes[0].Footer.Format.Field = "editorType" }, "writes.footer.format.field"},
		{"footer format is not the text", func(d *store.ConnectorDescriptor) { d.ServerHeld.Writes[0].Footer.Format.Field = "/text" }, "writes.footer.format.field is not"},
		{"footer format value is required", func(d *store.ConnectorDescriptor) { d.ServerHeld.Writes[0].Footer.Format.Value = "" }, "writes.footer.format.value"},
		{"footer format escape is markdown", func(d *store.ConnectorDescriptor) { d.ServerHeld.Writes[0].Footer.Format.Escape = "html" }, "writes.footer.format.escape"},
		{"footer plain lists distinct values", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Writes[0].Footer.Format.Plain = []string{"simple", "simple"}
		}, "writes.footer.format.plain"},
		{"footer plain is not the markdown value", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Writes[0].Footer.Format.Plain = []string{"markdown"}
		}, "writes.footer.format.plain"},
	}
	for _, c := range cases {
		descriptor := ackDescriptor()
		c.change(&descriptor)
		err := checkDescriptor(descriptor)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}
