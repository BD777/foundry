package httpapi

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A registration may carry the worker's event-loop stalls; the server logs
// each one and still accepts fields it does not know.
func TestWorkerStallsAreLoggedFromRegistration(t *testing.T) {
	payload := json.RawMessage(`{
		"device": {"id": "dev_1", "label": "byte-dev"},
		"workspace": {"id": "ws_1"},
		"activeSessionIds": [],
		"providerHealth": [], "assets": [], "agents": [], "skills": [], "workspaceFiles": [],
		"stalls": [{"at": "2026-10-09T06:10:18Z", "lagMs": 72400, "activities": ["registration", "skill scan reply"]}],
		"fieldFromANewerWorker": true
	}`)
	var registration store.DaemonRegistration
	if err := decodeWebSocketPayload(payload, &registration); err != nil {
		t.Fatalf("registration with stalls refused: %v", err)
	}
	if len(registration.Stalls) != 1 || registration.Stalls[0].LagMs != 72400 {
		t.Fatalf("stalls = %+v", registration.Stalls)
	}
	var output bytes.Buffer
	log.SetOutput(&output)
	defer log.SetOutput(os.Stderr)
	logWorkerStalls(registration)
	want := "device byte-dev worker stalled 72.4s during registration, skill scan reply at 2026-10-09T06:10:18Z"
	if !strings.Contains(output.String(), want) {
		t.Fatalf("log = %q, want %q", output.String(), want)
	}
}
