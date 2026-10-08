package httpapi

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A second scan of a device while one is running waits for it instead of
// making the device scan again.
func TestConcurrentSkillScansOfOneDeviceShareOneScan(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	hub := fixture.server.hub
	connection := newDaemonConnection(hub, nil)
	connection.deviceID = fixture.deviceID
	hub.connections[fixture.deviceID] = connection
	defer close(connection.done)

	var requests atomic.Int32
	release := make(chan struct{})
	go func() {
		for envelope := range connection.send {
			if envelope.Type != wsScanSkillsType {
				continue
			}
			requests.Add(1)
			<-release
			payload, _ := json.Marshal(wsSkillsScannedPayload{Skills: []store.DeviceSkill{{Name: "notes", Root: "~/.claude/skills", DirName: "notes"}}})
			_ = deliverDaemonResponse[wsSkillsScannedPayload](connection, wsEnvelope{ID: envelope.ID, Type: wsSkillsScannedType, Payload: payload}, nil)
		}
	}()

	roots := []string{"~/.claude/skills"}
	var wg sync.WaitGroup
	results := make([][]store.DeviceSkill, 2)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			skills, err := hub.ScanDeviceSkills(context.Background(), fixture.deviceID, roots)
			if err != nil {
				t.Errorf("scan %d: %v", i, err)
			}
			results[i] = skills
		}()
	}
	// Both callers are in before the device answers.
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := requests.Load(); n != 1 {
		t.Fatalf("device asked to scan %d times, want 1", n)
	}
	for i, skills := range results {
		if len(skills) != 1 || skills[0].Name != "notes" {
			t.Fatalf("caller %d got %+v", i, skills)
		}
	}
	// Once it finished, a new scan asks the device again.
	release = make(chan struct{})
	close(release)
	if _, err := hub.ScanDeviceSkills(context.Background(), fixture.deviceID, roots); err != nil {
		t.Fatal(err)
	}
	if n := requests.Load(); n != 2 {
		t.Fatalf("device asked to scan %d times after a new request, want 2", n)
	}
}
