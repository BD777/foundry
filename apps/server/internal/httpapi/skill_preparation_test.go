package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

func TestSkillPreparationSelectsOnlyDeviceWorkspaceRevisions(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	archive, _ := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: selected\n---\nfirst"})
	skill, _, err := f.server.store.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: "dev_alice", Root: "/skills", DirName: "selected"}, "selected", "", archive, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.store.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{WorkspaceID: "ws_alice", SkillIDs: []string{skill.ID}}); err != nil {
		t.Fatal(err)
	}
	index, err := f.server.store.GetSkillRevisionIndex(ctx, skill.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	h := NewDaemonHub(f.server.store, daemonNotifiers{}, "")
	for _, device := range []string{"dev_alice", "dev_bob", "dev_old"} {
		caps := []string{skillPreparationCapability}
		if device == "dev_old" {
			caps = nil
		}
		h.connections[device] = &daemonConnection{deviceID: device, done: make(chan struct{}), send: make(chan wsEnvelope, 10), registration: store.DaemonRegistration{Capabilities: caps}}
	}
	if err := h.prepareSelectedSkills(ctx); err != nil {
		t.Fatal(err)
	}
	for _, device := range []string{"dev_alice", "dev_bob"} {
		message := <-h.connections[device].send
		if message.Type != wsPrepareSkillsType {
			t.Fatal(message.Type)
		}
		var payload struct {
			Refs []store.SessionSkillRef `json:"refs"`
		}
		if err := json.Unmarshal(message.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, ref := range payload.Refs {
			if len(ref.SourceDigest) != 64 {
				t.Fatalf("missing trusted content digest: %+v", ref)
			}
			if ref.SkillID == skill.ID {
				found = true
				if ref.Revision != 1 || ref.SourceDigest != index.SourceDigest {
					t.Fatalf("wrong revision: %+v", ref)
				}
			}
		}
		if found != (device == "dev_alice") {
			t.Fatalf("selected private Skill reached wrong device: %s", device)
		}
	}
	if len(h.connections["dev_old"].send) != 0 {
		t.Fatal("older worker was sent preparation")
	}
}

func TestSkillPreparationConnectionAndSelectionChange(t *testing.T) {
	server := NewServer(newEmptyTestStore(t))
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities": []string{skillPreparationCapability},
		"device":       map[string]any{"id": "dev_warm", "label": "Preparation test", "status": "connected"},
		"workspace":    map[string]any{"id": "ws_warm", "name": "Preparation test", "localPath": "/tmp/prepare", "baseline": "main"},
	})
	readWSTypeForTest(t, conn, "registered")
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	readWSTypeForTest(t, conn, wsPrepareSkillsType)
	archive, _ := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: newly-selected\n---\nmethod"})
	skill, _, err := server.store.AddPromotedSkillRevision(context.Background(), store.PromoteSkillInput{DeviceID: "dev_warm", Root: "/skills", DirName: "newly-selected"}, "newly-selected", "", archive, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.store.SetWorkspaceSkills(context.Background(), store.SetWorkspaceSkillsInput{WorkspaceID: "ws_warm", SkillIDs: []string{skill.ID}}); err != nil {
		t.Fatal(err)
	}
	server.projectionsChanged("ws_warm", fieldWorkspaceSkillBindings)
	var message wsEnvelope
	for {
		if err := conn.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message.Type == wsPrepareSkillsType {
			break
		}
	}
	var payload wsPrepareSkillsPayload
	if err := json.Unmarshal(message.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ref := range payload.Refs {
		if ref.SkillID == skill.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("selection change did not prepare the new revision")
	}
	// Additional folders register after hello; they must also trigger preparation.
	writeWSForTest(t, conn, wsWorkspaceReadyType, map[string]any{
		"registration": map[string]any{
			"capabilities": []string{skillPreparationCapability},
			"device":       map[string]any{"id": "dev_warm", "label": "Preparation test", "status": "connected"},
			"workspace":    map[string]any{"id": "ws_warm_later", "name": "Later folder", "localPath": "/tmp/prepare-later", "baseline": "main"},
		},
	})
	readWSTypeForTest(t, conn, "registered")
	readWSTypeForTest(t, conn, wsPrepareSkillsType)

}

func TestSkillPreparationChangeFilter(t *testing.T) {
	for _, fields := range [][]string{workspaceSkillFields, skillLibraryFields, {fieldWorkspaceSkillBindings}, {fieldDefaultBundleIDs}} {
		if !skillPreparationChanged(fields) {
			t.Fatalf("missed change: %v", fields)
		}
	}
	if skillPreparationChanged(connectionFields) {
		t.Fatal("unrelated profile update triggers preparation")
	}
}
