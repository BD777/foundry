package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// runnerReportsFeature: this server takes execution_runner, the worker's
// session runner and its switch.
const runnerReportsFeature = "runner_reports"

// deviceRunners keeps what each connected worker last said of its session
// runner; it holds for that connection only.
type deviceRunners struct {
	mu      sync.Mutex
	reports map[string]deviceRunnerReport
}

type deviceRunnerReport struct {
	connection *daemonConnection
	runner     store.DeviceRunner
}

func (r *deviceRunners) set(deviceID string, connection *daemonConnection, runner store.DeviceRunner) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reports == nil {
		r.reports = map[string]deviceRunnerReport{}
	}
	previous, ok := r.reports[deviceID]
	r.reports[deviceID] = deviceRunnerReport{connection: connection, runner: runner}
	return !ok || previous.connection != connection || previous.runner != runner
}

func (r *deviceRunners) get(deviceID string, connection *daemonConnection) (store.DeviceRunner, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	report, ok := r.reports[deviceID]
	if !ok || connection == nil || report.connection != connection {
		return store.DeviceRunner{}, false
	}
	return report.runner, true
}

// recordDeviceRunner takes a worker's news of its runner and tells whoever
// sees the device.
func (s *Server) recordDeviceRunner(c *daemonConnection, deviceID string, runner store.DeviceRunner) {
	if s.deviceRunners.set(deviceID, c, runner) {
		s.workerUpdateChanged(deviceID)
	}
}

// withDeviceRunners adds each connected device's runner.
func (s *Server) withDeviceRunners(devices []store.DeviceProjection) []store.DeviceProjection {
	for i := range devices {
		if runner, ok := s.deviceRunners.get(devices[i].ID, s.hub.connectionFor(devices[i].ID)); ok {
			runner := runner
			devices[i].Runner = &runner
		}
	}
	return devices
}

func (c *daemonConnection) onExecutionRunner(_ context.Context, envelope wsEnvelope) error {
	var runner store.DeviceRunner
	if err := decodeWebSocketPayload(envelope.Payload, &runner); err != nil {
		return err
	}
	if deviceID, _ := c.registrationSnapshot(); deviceID != "" && c.hub.onDeviceRunner != nil {
		c.hub.onDeviceRunner(c, deviceID, runner)
	}
	return nil
}

type wsExecutionRunnerRead struct {
	store.DeviceRunnerDetail
	Error string `json:"error,omitempty"`
}

type wsExecutionRunnerSwitched struct {
	Switched bool   `json:"switched,omitempty"`
	Error    string `json:"error,omitempty"`
	// Changed: a turn started since the owner reviewed the list.
	Changed bool `json:"changed,omitempty"`
}

func (s *Server) runnerConnection(w http.ResponseWriter, r *http.Request) (*daemonConnection, bool) {
	connection := s.hub.connectionFor(strings.TrimSpace(r.PathValue("deviceId")))
	if connection == nil {
		writeError(w, http.StatusConflict, "The device is offline.")
		return nil, false
	}
	if !connection.hasCapability(runnerReportsFeature) {
		writeError(w, http.StatusConflict, "This worker does not report its session runner; update it first.")
		return nil, false
	}
	return connection, true
}

// handleReadDeviceRunner lists the turns a "switch now" would stop, with
// their sessions' titles, for the device's owner.
func (s *Server) handleReadDeviceRunner(w http.ResponseWriter, r *http.Request) {
	connection, ok := s.runnerConnection(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	value, err := daemonRequest[wsExecutionRunnerRead](ctx, connection, wsReadExecutionRunnerType, []byte("{}"))
	if err == nil && value.Error != "" {
		err = errWorkerUpdateRefused{value.Error}
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	detail := value.DeviceRunnerDetail
	if detail.Turns == nil {
		detail.Turns = []store.DeviceRunnerTurn{}
	}
	for i := range detail.Turns {
		if session, err := s.store.GetAgentSessionSummary(r.Context(), detail.Turns[i].SessionID); err == nil {
			detail.Turns[i].Title = session.Title
			detail.Turns[i].WorkspaceID = session.WorkspaceID
		}
	}
	writeJSON(w, http.StatusOK, detail)
}

// handleSwitchDeviceRunner is the owner's "switch now": the worker stops
// exactly the turns the owner reviewed and switches its runner. A turn that
// started since is not stopped; the owner is asked to review again.
func (s *Server) handleSwitchDeviceRunner(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Turns []store.DeviceRunnerTurn `json:"turns"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	connection, ok := s.runnerConnection(w, r)
	if !ok {
		return
	}
	turns := make([]map[string]string, 0, len(body.Turns))
	reviewed := map[string]bool{}
	for _, turn := range body.Turns {
		if turn.SessionID == "" || turn.Background {
			continue
		}
		reviewed[turn.SessionID+"/"+turn.InputID] = true
		turns = append(turns, map[string]string{"sessionId": turn.SessionID, "inputId": turn.InputID})
	}
	// The turns stop the way a person's Stop does, so their sessions read
	// as canceled and continue with the next message. Only when exactly
	// the reviewed turns still run; the worker checks again before it
	// switches.
	readCtx, cancelRead := context.WithTimeout(r.Context(), 20*time.Second)
	current, err := daemonRequest[wsExecutionRunnerRead](readCtx, connection, wsReadExecutionRunnerType, []byte("{}"))
	cancelRead()
	if err == nil && current.Error != "" {
		err = errWorkerUpdateRefused{current.Error}
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	for _, turn := range current.Turns {
		if !turn.Background && !reviewed[turn.SessionID+"/"+turn.InputID] {
			writeError(w, http.StatusConflict, "Another turn started since the list was shown; review it again.")
			return
		}
	}
	actor := actorFromContext(r.Context())
	for _, turn := range current.Turns {
		if turn.Background {
			continue
		}
		if _, err := s.cancelSession(r.Context(), actor, turn.SessionID); err != nil {
			log.Printf("switch runner now: stopping %s: %v", turn.SessionID, err)
		}
	}
	payload, err := json.Marshal(map[string]any{"turns": turns})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Stopping turns and starting the new runner takes up to a minute.
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	value, err := daemonRequest[wsExecutionRunnerSwitched](ctx, connection, wsSwitchExecutionRunnerType, payload)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if value.Changed {
		writeError(w, http.StatusConflict, value.Error)
		return
	}
	if value.Error != "" {
		writeError(w, http.StatusBadGateway, value.Error)
		return
	}
	writeJSON(w, http.StatusOK, value)
}
