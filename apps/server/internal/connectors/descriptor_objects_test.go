package connectors

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A write declaration's objects and resolvers are checked so a descriptor
// cannot claim a target that can never be read (DEV-265).
func TestDescriptorChecksWriteObjectsAndResolvers(t *testing.T) {
	valid := ackDescriptor()
	valid.ServerHeld.Writes = []store.ConnectorServerHeldWrite{{
		Method: "POST", Path: "/api/conversations/:feedId/messages", CreatedMessageID: "/messageId",
		Objects: []store.ConnectorServerHeldWriteObject{{Type: "conversation", From: ":feedId"}},
	}, {Method: "POST", Path: "/api/notes", Summary: "新建笔记"}}
	valid.ServerHeld.Resolvers = []store.ConnectorServerHeldResolver{{
		From: "message", To: "conversation", Method: "GET",
		Path: "/api/messages/:messageId", Pointer: "/item/feedId",
	}}
	valid.ServerHeld.Labels = []store.ConnectorServerHeldLabel{{
		Object: "conversation", Method: "GET", Path: "/api/conversations/:feedId", Pointer: "/name",
	}}
	if err := checkDescriptor(valid); err != nil {
		t.Fatalf("a valid declaration: %v", err)
	}
	cases := []struct {
		name   string
		change func(*store.ConnectorDescriptor)
		want   string
	}{
		{"object names a path parameter", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Writes[0].Objects[0].From = ":messageId"
		}, "objects.from"},
		{"auxiliary touches no object", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Writes[0].Auxiliary = true
		}, "auxiliary"},
		{"a write names something", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Writes[0] = store.ConnectorServerHeldWrite{Method: "POST", Path: "/api/conversations/:feedId/messages"}
		}, "operation summary"},
		{"resolver has one parameter", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Resolvers[0].Path = "/api/conversations/:feedId/messages/:messageId"
		}, "exactly one parameter"},
		{"resolver names a pointer", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Resolvers[0].Pointer = "item.feedId"
		}, "resolvers.pointer"},
		{"resolver ttl is bounded", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Resolvers[0].TTLSeconds = 5
		}, "ttlSeconds"},
		{"label names one object once", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Labels = append(d.ServerHeld.Labels, d.ServerHeld.Labels[0])
		}, "each object type once"},
		{"label has one parameter", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Labels[0].Path = "/api/conversations/:feedId/messages/:messageId"
		}, "exactly one parameter"},
		{"label names a pointer", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Labels[0].Pointer = "name"
		}, "labels.pointer"},
		{"label ttl is bounded", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Labels[0].TTLSeconds = 7200
		}, "ttlSeconds"},
		{"write summary is bounded", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Writes[1].Summary = strings.Repeat("x", 201)
		}, "writes.summary"},
		{"route summary extraction is a pointer", func(d *store.ConnectorDescriptor) {
			d.ServerHeld.Probe[2].Extract.Routes.Summary = "summary"
		}, "route summary extraction"},
	}
	for _, tc := range cases {
		descriptor := ackDescriptor()
		descriptor.ServerHeld.Writes = []store.ConnectorServerHeldWrite{{
			Method: "POST", Path: "/api/conversations/:feedId/messages", CreatedMessageID: "/messageId",
			Objects: []store.ConnectorServerHeldWriteObject{{Type: "conversation", From: ":feedId"}},
		}, {Method: "POST", Path: "/api/notes", Summary: "新建笔记"}}
		descriptor.ServerHeld.Resolvers = []store.ConnectorServerHeldResolver{{
			From: "message", To: "conversation", Method: "GET",
			Path: "/api/messages/:messageId", Pointer: "/item/feedId",
		}}
		descriptor.ServerHeld.Labels = []store.ConnectorServerHeldLabel{{
			Object: "conversation", Method: "GET", Path: "/api/conversations/:feedId", Pointer: "/name",
		}}
		tc.change(&descriptor)
		err := checkDescriptor(descriptor)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
}
