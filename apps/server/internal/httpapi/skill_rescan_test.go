package httpapi

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A connected device's skill folders are scanned again every half hour. A
// scan that finds the same skills and tools must leave workspace data as it
// was: the device's skillsVersion, the foundry-data ETag clients revalidate
// with, and no foundry_data_changed. A scan that finds a change moves them.
func TestUnchangedSkillRescanLeavesWorkspaceDataAlone(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	server := fixture.server
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()

	connection := newDaemonConnection(server.hub, nil)
	connection.deviceID = fixture.deviceID
	server.hub.connections[fixture.deviceID] = connection
	defer close(connection.done)
	var answer atomic.Pointer[wsSkillsScannedPayload]
	answer.Store(&wsSkillsScannedPayload{
		Skills: []store.DeviceSkill{{Root: "~/.claude/skills", DirName: "notes", Name: "notes", Description: "Take notes", MtimeLabel: "2026-10-01T08:00:00Z"}},
		Tools:  map[string]bool{"ffmpeg": true},
	})
	go func() {
		for envelope := range connection.send {
			if envelope.Type != wsScanSkillsType {
				continue
			}
			payload, _ := json.Marshal(answer.Load())
			_ = deliverDaemonResponse[wsSkillsScannedPayload](connection, wsEnvelope{ID: envelope.ID, Type: wsSkillsScannedType, Payload: payload}, nil)
		}
	}()

	viewer := subscribeForTest(server.stream)
	announcements := func() int {
		count := 0
		for len(viewer.C) > 0 {
			<-viewer.C
			count++
		}
		return count
	}
	scan := func() {
		t.Helper()
		requestForTest(t, server, http.MethodPost, "/api/device-skills/scan?deviceId="+fixture.deviceID, "", http.StatusOK)
	}
	type view struct{ etag, skillsVersion string }
	read := func() view {
		t.Helper()
		response := requestForTest(t, server, http.MethodGet, "/api/foundry-data?workspaceId="+fixture.workspace.ID, "", http.StatusOK)
		var data struct {
			Devices []store.DeviceProjection `json:"devices"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
			t.Fatalf("decode foundry-data: %v", err)
		}
		for _, device := range data.Devices {
			if device.ID == fixture.deviceID {
				return view{etag: response.Header().Get("ETag"), skillsVersion: device.SkillsVersion}
			}
		}
		t.Fatalf("%s missing from foundry-data", fixture.deviceID)
		return view{}
	}

	scan()
	if announcements() == 0 {
		t.Fatal("the first scan announced nothing")
	}
	first := read()
	if first.etag == "" || first.skillsVersion == "" {
		t.Fatalf("foundry-data view = %+v", first)
	}

	scan()
	if n := announcements(); n != 0 {
		t.Fatalf("an unchanged rescan announced %d changes", n)
	}
	if again := read(); again != first {
		t.Fatalf("an unchanged rescan moved workspace data: %+v -> %+v", first, again)
	}
	if _, changed, err := server.hub.ScanDeviceSkills(t.Context(), fixture.deviceID, []string{"~/.claude/skills"}); err != nil || changed {
		t.Fatalf("periodic rescan: changed=%v err=%v", changed, err)
	}

	answer.Store(&wsSkillsScannedPayload{
		Skills: []store.DeviceSkill{{Root: "~/.claude/skills", DirName: "notes", Name: "notes", Description: "Take better notes", MtimeLabel: "2026-10-11T08:00:00Z"}},
		Tools:  map[string]bool{"ffmpeg": true},
	})
	scan()
	if announcements() == 0 {
		t.Fatal("a scan that changed a skill announced nothing")
	}
	edited := read()
	if edited.etag == first.etag || edited.skillsVersion == first.skillsVersion {
		t.Fatalf("a changed skill left workspace data as it was: %+v -> %+v", first, edited)
	}

	// A program that went missing is a change too, though not to the skills.
	answer.Store(&wsSkillsScannedPayload{
		Skills: answer.Load().Skills,
		Tools:  map[string]bool{"ffmpeg": false},
	})
	scan()
	if announcements() == 0 {
		t.Fatal("a scan that changed a tool announced nothing")
	}
	if tools := read(); tools.etag == edited.etag || tools.skillsVersion != edited.skillsVersion {
		t.Fatalf("a changed tool: %+v -> %+v", edited, tools)
	}

	var listed struct {
		ScannedAt string `json:"scannedAt"`
	}
	response := requestForTest(t, server, http.MethodGet, "/api/device-skills?deviceId="+fixture.deviceID, "", http.StatusOK)
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil || listed.ScannedAt == "" {
		t.Fatalf("device skills scannedAt = %q, %v", listed.ScannedAt, err)
	}
}
