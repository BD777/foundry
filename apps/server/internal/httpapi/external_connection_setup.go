package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Setting up an external connection on another of the person's devices
// (docs/external-connections.md, "Setup on another device"). A gateway's
// installer registers setup metadata with the connection; the server offers
// that connection on the owner's other devices from the profiles they
// reported, reads the setup's progress from the target device while the
// person watches, and may run the registered command there ("Set it up for
// me") when the device's owner allows remote commands. The command always
// comes from the device-reported record, never from the request.

// externalConnectionSetupCapability: the worker answers
// read/start/cancel_external_connection_setup.
const externalConnectionSetupCapability = "external_connection_setup_v1"

// How long the last progress a device reported is remembered for the picker.
const externalSetupMemory = time.Hour

type externalConnectionSetupProgress struct {
	ProfileID string `json:"profileId"`
	State     string `json:"state"`
	UpdatedAt string `json:"updatedAt"`
	SignInURL string `json:"signInUrl,omitempty"`
	UserCode  string `json:"userCode,omitempty"`
	Message   string `json:"message,omitempty"`
}

type externalConnectionSetupRun struct {
	RunID      string `json:"runId"`
	ProfileID  string `json:"profileId"`
	State      string `json:"state"`
	StartedAt  string `json:"startedAt"`
	EndedAt    string `json:"endedAt,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Output     string `json:"output"`
	Offset     int    `json:"offset"`
	NextOffset int    `json:"nextOffset"`
	Truncated  bool   `json:"truncated,omitempty"`
}

type externalConnectionLiveState struct {
	HelperAvailable bool                    `json:"helperAvailable"`
	Check           externalConnectionCheck `json:"check"`
}

type wsReadExternalConnectionSetup struct {
	ProfileID string `json:"profileId"`
	RunID     string `json:"runId,omitempty"`
	After     int    `json:"after,omitempty"`
}

type wsExternalConnectionSetupRead struct {
	Connection     *externalConnectionLiveState     `json:"connection,omitempty"`
	Progress       *externalConnectionSetupProgress `json:"progress,omitempty"`
	Run            *externalConnectionSetupRun      `json:"run,omitempty"`
	RemoteCommands bool                             `json:"remoteCommands"`
	Error          string                           `json:"error,omitempty"`
	ErrorCode      string                           `json:"errorCode,omitempty"`
}

type wsStartExternalConnectionSetup struct {
	ProfileID string `json:"profileId"`
	Command   string `json:"command"`
}

type wsCancelExternalConnectionSetup struct {
	ProfileID string `json:"profileId"`
	RunID     string `json:"runId"`
}

type wsExternalConnectionSetupRunReply struct {
	Run       *externalConnectionSetupRun `json:"run,omitempty"`
	Error     string                      `json:"error,omitempty"`
	ErrorCode string                      `json:"errorCode,omitempty"`
}

type externalConnectionOffer struct {
	ProfileID     string                             `json:"profileId"`
	Label         string                             `json:"label"`
	Runtime       string                             `json:"runtime"`
	Model         string                             `json:"model,omitempty"`
	Models        []string                           `json:"models,omitempty"`
	Setup         *store.ExternalConnectionSetupInfo `json:"setup,omitempty"`
	SetupDigest   string                             `json:"setupDigest,omitempty"`
	SetupSource   *externalConnectionSetupSource     `json:"setupSource,omitempty"`
	OtherSetups   []externalConnectionOtherSetup     `json:"otherSetups,omitempty"`
	SourceDevices []externalConnectionSourceDevice   `json:"sourceDevices"`
	Stage         string                             `json:"stage"`
	Detail        string                             `json:"detail,omitempty"`
}

type externalConnectionSetupSource struct {
	DeviceID string `json:"deviceId"`
	Label    string `json:"label"`
}

type externalConnectionOtherSetup struct {
	DeviceID     string `json:"deviceId"`
	Label        string `json:"label"`
	Command      string `json:"command"`
	RegisteredAt string `json:"registeredAt,omitempty"`
}

type externalConnectionSourceDevice struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type externalConnectionSetupDetail struct {
	Offer    externalConnectionOffer          `json:"offer"`
	Device   externalConnectionSetupDevice    `json:"device"`
	Live     bool                             `json:"live"`
	Progress *externalConnectionSetupProgress `json:"progress,omitempty"`
	Run      *externalConnectionSetupRun      `json:"run,omitempty"`
	Remote   externalConnectionSetupRemote    `json:"remote"`
}

type externalConnectionSetupDevice struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	User   string `json:"user,omitempty"`
	OS     string `json:"os,omitempty"`
	Online bool   `json:"online"`
}

type externalConnectionSetupRemote struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// externalSetupMemo keeps what a device last said about a setup (no
// output), so the picker shows "waiting for sign-in" without asking it.
type externalSetupMemo struct {
	mu      sync.Mutex
	entries map[string]externalSetupMemoEntry
}

type externalSetupMemoEntry struct {
	at       time.Time
	progress *externalConnectionSetupProgress
	run      *externalConnectionSetupRun
}

func (m *externalSetupMemo) remember(deviceID, profileID string, progress *externalConnectionSetupProgress, run *externalConnectionSetupRun) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.entries == nil {
		m.entries = map[string]externalSetupMemoEntry{}
	}
	var summary *externalConnectionSetupRun
	if run != nil {
		copied := *run
		copied.Output = ""
		summary = &copied
	}
	m.entries[deviceID+"\x00"+profileID] = externalSetupMemoEntry{at: time.Now(), progress: progress, run: summary}
}

func (m *externalSetupMemo) recall(deviceID, profileID string) (*externalConnectionSetupProgress, *externalConnectionSetupRun) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[deviceID+"\x00"+profileID]
	if !ok || time.Since(entry.at) > externalSetupMemory {
		return nil, nil
	}
	return entry.progress, entry.run
}

func (s *Server) handleListExternalConnectionSetups(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	offers, err := s.externalConnectionOffers(r, deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	// Ask a connected device where each setup stands; otherwise use what it
	// last said.
	connection := s.hub.connectionFor(deviceID)
	if connection != nil && !connection.hasCapability(externalConnectionSetupCapability) {
		connection = nil
	}
	for i := range offers {
		target := offers[i].target
		var live *externalConnectionLiveState
		progress, run := s.externalSetups.recall(deviceID, offers[i].ProfileID)
		if connection != nil {
			value, err := externalConnectionSetupCall[wsExternalConnectionSetupRead](r.Context(), connection, wsReadExternalConnectionSetupType,
				wsReadExternalConnectionSetup{ProfileID: offers[i].ProfileID, After: math.MaxInt32}, 5*time.Second)
			if err == nil {
				progress, run, live = value.Progress, value.Run, value.Connection
				if live == nil {
					target = nil
				}
				s.externalSetups.remember(deviceID, offers[i].ProfileID, progress, run)
			}
		}
		offers[i].Stage, offers[i].Detail = externalSetupStage(target, live, progress, run)
	}
	writeJSON(w, http.StatusOK, map[string]any{"deviceId": deviceID, "offers": offerList(offers)})
}

func (s *Server) handleGetExternalConnectionSetup(w http.ResponseWriter, r *http.Request) {
	deviceID, offer, ok := s.externalConnectionSetupTarget(w, r)
	if !ok {
		return
	}
	after, _ := strconv.Atoi(r.URL.Query().Get("after"))
	detail := externalConnectionSetupDetail{Offer: offer.externalConnectionOffer, Device: s.externalSetupDevice(r.Context(), deviceID)}
	connection := s.hub.connectionFor(deviceID)
	var reply *wsExternalConnectionSetupRead
	switch {
	case connection == nil:
		detail.Remote.Reason = "offline"
	case !connection.hasCapability(externalConnectionSetupCapability):
		detail.Remote.Reason = "old_worker"
	default:
		value, err := externalConnectionSetupCall[wsExternalConnectionSetupRead](r.Context(), connection, wsReadExternalConnectionSetupType,
			wsReadExternalConnectionSetup{ProfileID: offer.ProfileID, RunID: strings.TrimSpace(r.URL.Query().Get("runId")), After: after}, 10*time.Second)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		reply = &value
		detail.Live = true
		detail.Progress, detail.Run = value.Progress, value.Run
		s.externalSetups.remember(deviceID, offer.ProfileID, value.Progress, value.Run)
		if !value.RemoteCommands {
			detail.Remote.Reason = "remote_commands_off"
		}
	}
	if offer.Setup == nil {
		detail.Remote.Reason = "no_command"
	}
	detail.Remote.Available = detail.Remote.Reason == ""
	if !detail.Live {
		detail.Progress, detail.Run = s.externalSetups.recall(deviceID, offer.ProfileID)
	}
	var live *externalConnectionLiveState
	if reply != nil {
		live = reply.Connection
		if live == nil {
			// Read just now: not registered there (any more).
			offer.target = nil
		}
	}
	detail.Offer.Stage, detail.Offer.Detail = externalSetupStage(offer.target, live, detail.Progress, detail.Run)
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleStartExternalConnectionSetup(w http.ResponseWriter, r *http.Request) {
	deviceID, offer, ok := s.externalConnectionSetupTarget(w, r)
	if !ok {
		return
	}
	if offer.Setup == nil {
		writeError(w, http.StatusConflict, "no setup command is registered for this connection")
		return
	}
	// Only the command the person was shown runs: the panel names its
	// digest, and a command registered since then is refused.
	var input struct {
		Digest string `json:"digest"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Digest) != offer.SetupDigest {
		writeError(w, http.StatusConflict, "the setup command changed since it was shown; review the new command before running it")
		return
	}
	connection, err := s.externalSetupConnection(deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	value, err := externalConnectionSetupCall[wsExternalConnectionSetupRunReply](r.Context(), connection, wsStartExternalConnectionSetupType,
		wsStartExternalConnectionSetup{ProfileID: offer.ProfileID, Command: offer.Setup.Command}, 20*time.Second)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.externalSetups.remember(deviceID, offer.ProfileID, nil, value.Run)
	writeJSON(w, http.StatusOK, map[string]any{"run": value.Run})
}

func (s *Server) handleCancelExternalConnectionSetup(w http.ResponseWriter, r *http.Request) {
	deviceID, offer, ok := s.externalConnectionSetupTarget(w, r)
	if !ok {
		return
	}
	runID := strings.TrimSpace(r.URL.Query().Get("runId"))
	if runID == "" {
		writeError(w, http.StatusBadRequest, "runId is required")
		return
	}
	connection, err := s.externalSetupConnection(deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	value, err := externalConnectionSetupCall[wsExternalConnectionSetupRunReply](r.Context(), connection, wsCancelExternalConnectionSetupType,
		wsCancelExternalConnectionSetup{ProfileID: offer.ProfileID, RunID: runID}, 20*time.Second)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": value.Run})
}

func (s *Server) externalSetupConnection(deviceID string) (*daemonConnection, error) {
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return nil, &statusError{http.StatusConflict, errors.New("connect this device before setting a connection up on it")}
	}
	if !connection.hasCapability(externalConnectionSetupCapability) {
		return nil, &statusError{http.StatusConflict, errors.New("update this device's Foundry worker to set connections up from Foundry")}
	}
	return connection, nil
}

func (s *Server) externalConnectionSetupTarget(w http.ResponseWriter, r *http.Request) (string, offerWithTarget, bool) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	profileID := strings.TrimSpace(r.PathValue("profileId"))
	offers, err := s.externalConnectionOffers(r, deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return "", offerWithTarget{}, false
	}
	for _, offer := range offers {
		if offer.ProfileID == profileID {
			return deviceID, offer, true
		}
	}
	writeError(w, http.StatusNotFound, "no such external connection for this device")
	return "", offerWithTarget{}, false
}

// offerWithTarget is an offer with the profile the device itself reported
// for it, if any.
type offerWithTarget struct {
	externalConnectionOffer
	target *store.AgentProfileProjection
}

func offerList(offers []offerWithTarget) []externalConnectionOffer {
	list := make([]externalConnectionOffer, 0, len(offers))
	for _, offer := range offers {
		list = append(list, offer.externalConnectionOffer)
	}
	return list
}

// externalConnectionOffers lists the external connections for one device:
// those it has, and those the same person registered with setup metadata on
// their other devices (offline ones included, as last reported).
func (s *Server) externalConnectionOffers(r *http.Request, deviceID string) ([]offerWithTarget, error) {
	scope, err := s.requestScope(r)
	if err != nil {
		return nil, err
	}
	profiles, err := s.store.ListAgentProfiles(r.Context(), "")
	if err != nil {
		return nil, err
	}
	devices, err := s.store.ListDevices(r.Context())
	if err != nil {
		return nil, err
	}
	labels := map[string]string{}
	for _, device := range devices {
		labels[device.ID] = device.Label
	}
	byID := map[string]*offerWithTarget{}
	order := []string{}
	offer := func(profile store.AgentProfileProjection) *offerWithTarget {
		entry, ok := byID[profile.ID]
		if !ok {
			entry = &offerWithTarget{externalConnectionOffer: externalConnectionOffer{
				ProfileID: profile.ID, Label: profile.Label, Runtime: profile.Runtime,
				Model: profile.Model, Models: profile.Models, SourceDevices: []externalConnectionSourceDevice{},
			}}
			byID[profile.ID] = entry
			order = append(order, profile.ID)
		}
		return entry
	}
	sort.SliceStable(profiles, func(i, j int) bool {
		return labels[profiles[i].DeviceID] < labels[profiles[j].DeviceID]
	})
	setups := map[string][]store.AgentProfileProjection{}
	for i := range profiles {
		profile := profiles[i]
		if profile.ConnectionType != "external" {
			continue
		}
		if profile.DeviceID == deviceID {
			entry := offer(profile)
			entry.target = &profile
			entry.Label, entry.Model, entry.Models = profile.Label, profile.Model, profile.Models
			if profile.ExternalSetup != nil {
				setups[profile.ID] = append(setups[profile.ID], profile)
			}
			continue
		}
		if profile.ExternalSetup == nil || !scope.ownsDevice(profile.DeviceID) {
			continue
		}
		entry := offer(profile)
		entry.SourceDevices = append(entry.SourceDevices, externalConnectionSourceDevice{ID: profile.DeviceID, Label: labels[profile.DeviceID]})
		setups[profile.ID] = append(setups[profile.ID], profile)
	}
	offers := make([]offerWithTarget, 0, len(order))
	for _, id := range order {
		entry := byID[id]
		chooseExternalSetup(entry, setups[id], deviceID, labels)
		offers = append(offers, *entry)
	}
	sort.SliceStable(offers, func(i, j int) bool { return offers[i].Label < offers[j].Label })
	return offers, nil
}

// chooseExternalSetup picks the command an offer shows: the newest any
// device registered (this device's own on a tie). Different commands from
// other devices are listed beside it, never merged.
func chooseExternalSetup(entry *offerWithTarget, candidates []store.AgentProfileProjection, deviceID string, labels map[string]string) {
	if len(candidates) == 0 {
		return
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i].ExternalSetup.RegisteredAt, candidates[j].ExternalSetup.RegisteredAt
		if a != b {
			return a > b
		}
		return candidates[i].DeviceID == deviceID && candidates[j].DeviceID != deviceID
	})
	chosen := candidates[0]
	setup := *chosen.ExternalSetup
	entry.Setup = &setup
	entry.SetupDigest = externalSetupDigest(setup.Command)
	entry.SetupSource = &externalConnectionSetupSource{DeviceID: chosen.DeviceID, Label: labels[chosen.DeviceID]}
	for _, other := range candidates[1:] {
		if other.ExternalSetup.Command == setup.Command {
			continue
		}
		entry.OtherSetups = append(entry.OtherSetups, externalConnectionOtherSetup{
			DeviceID: other.DeviceID, Label: labels[other.DeviceID],
			Command: other.ExternalSetup.Command, RegisteredAt: other.ExternalSetup.RegisteredAt,
		})
	}
}

func externalSetupDigest(command string) string {
	sum := sha256.Sum256([]byte(command))
	return hex.EncodeToString(sum[:])
}

func (s *Server) externalSetupDevice(ctx context.Context, deviceID string) externalConnectionSetupDevice {
	device := externalConnectionSetupDevice{ID: deviceID, Label: deviceID}
	var system *store.DeviceSystem
	if connection := s.hub.connectionFor(deviceID); connection != nil {
		device.Online = true
		_, registration := connection.registrationSnapshot()
		if registration.Device.Label != "" {
			device.Label = registration.Device.Label
		}
		system = registration.Device.System
	}
	if devices, err := s.store.ListDevices(ctx); err == nil {
		for _, item := range devices {
			if item.ID == deviceID {
				device.Label = item.Label
				if system == nil {
					system = item.System
				}
			}
		}
	}
	if system != nil {
		device.User, device.OS = system.User, system.OS
	}
	return device
}

// externalSetupStage is where a connection stands on the device, from what
// the device reported (target) or answered just now (live), and the setup
// in progress there.
func externalSetupStage(target *store.AgentProfileProjection, live *externalConnectionLiveState, progress *externalConnectionSetupProgress, run *externalConnectionSetupRun) (string, string) {
	running := run != nil && run.State == "running"
	registered, helper, check, message := false, false, "", ""
	switch {
	case live != nil:
		registered, helper, check, message = true, live.HelperAvailable, live.Check.Status, live.Check.Message
	case target != nil:
		registered = true
		// A registered connection without a check result that is not
		// healthy is one whose helper is missing (profiles.ts).
		helper = target.Status == "healthy" || target.Check != nil
		if target.Check != nil {
			check, message = target.Check.Status, target.Check.Message
		}
		if target.Status == "healthy" {
			check = "passed"
		}
	}
	if registered && helper {
		switch check {
		case "passed":
			return "ready", ""
		case "failed":
			return "check_failed", message
		default:
			return "unchecked", ""
		}
	}
	if progress != nil {
		switch progress.State {
		case "waiting_sign_in":
			return "waiting_sign_in", ""
		case "failed":
			if !running {
				return "setup_failed", progress.Message
			}
		default:
			return "in_progress", ""
		}
	}
	if running {
		return "in_progress", ""
	}
	if run != nil && run.State != "succeeded" && run.State != "cancelled" {
		return "setup_failed", ""
	}
	return "not_set_up", ""
}

// externalConnectionSetupCall sends one setup request to the device and maps
// its refusal onto an HTTP status.
func externalConnectionSetupCall[T any](ctx context.Context, connection *daemonConnection, requestType string, request any, timeout time.Duration) (T, error) {
	var zero T
	payload, err := json.Marshal(request)
	if err != nil {
		return zero, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	raw, err := daemonRequest[json.RawMessage](ctx, connection, requestType, payload)
	if err != nil {
		return zero, err
	}
	var refusal struct {
		Error     string `json:"error"`
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(raw, &refusal); err != nil {
		return zero, err
	}
	if refusal.Error != "" {
		status := http.StatusBadGateway
		switch refusal.ErrorCode {
		case "busy", "remote_commands_off":
			status = http.StatusConflict
		case "not_found":
			status = http.StatusNotFound
		case "invalid_input":
			status = http.StatusBadRequest
		}
		return zero, &statusError{status, errors.New(refusal.Error)}
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return zero, err
	}
	return value, nil
}
