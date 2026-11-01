package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// A device that offers permessage-deflate gets it, and the server takes its
// compressed messages; the upgrade names what the server takes.
func TestDaemonSocketCompressesWhenTheDeviceOffersIt(t *testing.T) {
	_, url := deadlineTestServer(t, 5*time.Second)
	dialer := &websocket.Dialer{EnableCompression: true}
	conn, response, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if got := response.Header.Get("Sec-WebSocket-Extensions"); !strings.Contains(got, "permessage-deflate") {
		t.Fatalf("extensions = %q, want permessage-deflate", got)
	}
	if got := response.Header.Get(daemonFeaturesHeader); !strings.Contains(got, registrationSectionsFeature) {
		t.Fatalf("%s = %q, want %s", daemonFeaturesHeader, got, registrationSectionsFeature)
	}
	writeWSForTest(t, conn, "hello", map[string]any{"device": map[string]any{"id": "dev_deflate", "label": "dev_deflate"}})
	readWSTypeForTest(t, conn, "registered")
	writeWSIDForTest(t, conn, "large", wsHeartbeatType, map[string]string{"pad": strings.Repeat("x", 256<<10)})
	readAckForTest(t, conn, "large")

	// Without the offer the socket carries plain frames as before.
	plain, response, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = plain.Close() })
	if got := response.Header.Get("Sec-WebSocket-Extensions"); got != "" {
		t.Fatalf("extensions without an offer = %q", got)
	}
}

func helloWithSections(deviceID string, omit bool) map[string]any {
	hello := map[string]any{
		"device":   map[string]any{"id": deviceID, "label": deviceID},
		"sections": map[string]string{"device": "digest-1", "workspace": "digest-2"},
	}
	if omit {
		hello["omittedSections"] = []string{"device"}
	} else {
		hello["providerHealth"] = []map[string]any{{"provider": "claude", "status": "ready", "authMode": "native", "secretStored": "none"}}
	}
	return hello
}

func readEnvelopeForTest(t *testing.T, conn *websocket.Conn) wsEnvelope {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var envelope wsEnvelope
	if err := conn.ReadJSON(&envelope); err != nil {
		t.Fatalf("read: %v", err)
	}
	return envelope
}

// A registration that leaves out a section the server does not have is
// answered registration_needed and not taken; once the device sent it
// whole, a later connection may leave it out and the server fills it in.
func TestRegistrationLeavesOutSectionsTheServerKeeps(t *testing.T) {
	server, url := deadlineTestServer(t, 5*time.Second)
	const deviceID = "dev_sections"

	first, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = first.Close() })
	writeWSIDForTest(t, first, "slim", wsHelloType, helloWithSections(deviceID, true))
	answer := readEnvelopeForTest(t, first)
	if answer.Type != wsRegistrationNeededType || answer.ID != "slim" {
		t.Fatalf("answer to a slim hello on a fresh server = %s %s, want registration_needed", answer.Type, answer.ID)
	}
	var needed wsRegistrationNeededPayload
	if err := json.Unmarshal(answer.Payload, &needed); err != nil || len(needed.Sections) != 1 || needed.Sections[0] != "device" {
		t.Fatalf("needed = %+v (%v)", needed, err)
	}
	if server.hub.connectionFor(deviceID) != nil {
		t.Fatal("a registration missing sections must not register the device")
	}
	writeWSIDForTest(t, first, "whole", wsHelloType, helloWithSections(deviceID, false))
	if answer := readEnvelopeForTest(t, first); answer.Type != wsRegisteredType {
		t.Fatalf("answer to the whole hello = %s %q", answer.Type, answer.Error)
	}
	_ = first.Close()

	second, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })
	writeWSIDForTest(t, second, "again", wsHelloType, helloWithSections(deviceID, true))
	if answer := readEnvelopeForTest(t, second); answer.Type != wsRegisteredType {
		t.Fatalf("answer to a slim hello the server can fill = %s %q", answer.Type, answer.Error)
	}
	connection := server.hub.connectionFor(deviceID)
	if connection == nil {
		t.Fatal("device not registered")
	}
	_, registration := connection.registrationSnapshot()
	if len(registration.ProviderHealth) != 1 || registration.ProviderHealth[0].Provider != "claude" {
		t.Fatalf("filled-in provider health = %+v", registration.ProviderHealth)
	}
}

func TestRegistrationSectionsAreKeptPerDeviceAndBounded(t *testing.T) {
	var kept registrationSections
	whole := store.DaemonRegistration{
		Sections:       map[string]string{"device": "a", "workspace": "b"},
		ProviderHealth: []store.ProviderHealth{{Provider: "codex"}},
		Assets:         []store.AssetProjection{{ID: "asset"}},
	}
	kept.keep("dev_a", whole)

	other := store.DaemonRegistration{Sections: whole.Sections, OmittedSections: []string{"device", "workspace"}}
	if err := kept.fill("dev_b", &other); err == nil {
		t.Fatal("another device's sections must not fill a registration")
	}
	slim := store.DaemonRegistration{Sections: whole.Sections, OmittedSections: []string{"device", "workspace"}}
	if err := kept.fill("dev_a", &slim); err != nil {
		t.Fatalf("fill: %v", err)
	}
	if len(slim.ProviderHealth) != 1 || len(slim.Assets) != 1 || slim.OmittedSections != nil {
		t.Fatalf("filled = %+v", slim)
	}
	// The filled registration is a copy: changing it leaves what is kept.
	slim.ProviderHealth[0].Provider = "changed"
	again := store.DaemonRegistration{Sections: whole.Sections, OmittedSections: []string{"device"}}
	if err := kept.fill("dev_a", &again); err != nil || again.ProviderHealth[0].Provider != "codex" {
		t.Fatalf("refilled = %+v (%v)", again.ProviderHealth, err)
	}
	unknown := store.DaemonRegistration{Sections: map[string]string{"other": "c"}, OmittedSections: []string{"other"}}
	if err := kept.fill("dev_a", &unknown); err == nil {
		t.Fatal("an unknown section cannot be filled")
	}

	for i := range maxSectionsPerDevice + 10 {
		kept.keep("dev_c", store.DaemonRegistration{Sections: map[string]string{"workspace": strings.Repeat("d", i+1)}})
	}
	if got := len(kept.devices["dev_c"]); got != maxSectionsPerDevice {
		t.Fatalf("kept %d sections, want at most %d", got, maxSectionsPerDevice)
	}
}

// A device whose skills did not change answers a scan with its digest; the
// server stores the answer it kept as if it had come again.
func TestSkillScanAnswerUnchangedUsesTheKeptAnswer(t *testing.T) {
	var kept keptSkillScans
	whole := wsSkillsScannedPayload{
		Skills: []store.DeviceSkill{{Root: "~/.claude/skills", DirName: "one", Name: "one"}},
		Tools:  map[string]bool{"git": true},
		Digest: "scan-1",
	}
	kept.keep("dev_scan", whole)
	known := kept.known("dev_scan")
	if known.digest != "scan-1" {
		t.Fatalf("known digest = %q", known.digest)
	}
	answer, err := scanAnswer(wsSkillsScannedPayload{Unchanged: true, Digest: "scan-1"}, known)
	if err != nil || len(answer.Skills) != 1 || answer.Skills[0].DirName != "one" || !answer.Tools["git"] {
		t.Fatalf("answer = %+v (%v)", answer, err)
	}
	if _, err := scanAnswer(wsSkillsScannedPayload{Unchanged: true, Digest: "other"}, known); err == nil {
		t.Fatal("an unchanged answer with another digest must fail")
	}
	if answer, _ := scanAnswer(whole, keptSkillScan{}); len(answer.Skills) != 1 {
		t.Fatal("a whole answer is taken as it came")
	}
}

// The reconnect line says what the worker sent after the connection opened.
func TestConnectionReportLineSaysWhatWasSent(t *testing.T) {
	line := describeConnectionReport(store.WorkerConnectionReport{
		DurationMs: 80_000, ClosedBy: "server", Compressed: true,
		SentAfterOpen: &store.WorkerSentAfterOpen{WindowMs: 180_000, Types: []store.WorkerSentCount{
			{Type: "workspace_ready", Count: 4, Bytes: 76_800}, {Type: "hello", Count: 1, Bytes: 19_456},
		}},
		Replayed:           &store.WorkerSentCount{Count: 40, Bytes: 61_440},
		OutboxPeak:         &store.WorkerOutboxPeak{Queued: 113, BufferedBytes: 122_880},
		LongestSendStallMs: 45_000,
	})
	for _, want := range []string{"compressed", "first 180s sent [workspace_ready 4x 75KB hello 19KB]", "replayed 40 outbox messages 60KB", "outbox peak 113 queued 120KB on socket", "longest send stall 45s"} {
		if !strings.Contains(line, want) {
			t.Fatalf("report line = %q, want %q", line, want)
		}
	}
}
