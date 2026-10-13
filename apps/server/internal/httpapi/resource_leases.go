package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Resource leases (package resources): who holds which instance, wired to
// the device hub (resets and operations go to the hosting worker), to
// session state (a turn is a lease's keep-alive) and to the person's routes
// (release, let finish, stop all, the audit, installing a backend).

// resourceLeaseSweep is how often lease timers are checked.
const resourceLeaseSweep = 5 * time.Second

// installResourceBackendTimeout bounds an official installer's run.
const installResourceBackendTimeout = 10 * time.Minute

// newResourceLeases builds the leases over the inventory.
func newResourceLeases(st Backend, inventory *resources.Service, hub *DaemonHub) *resources.Leases {
	leases := resources.NewLeases(inventory, st)
	leases.HostOnline = hub.HasConnection
	leases.Router = deviceResourceRouter{hub: hub}
	leases.Session = func(ctx context.Context, sessionID string) (resources.SessionInfo, error) {
		session, err := st.GetAgentSessionSummary(ctx, sessionID)
		if err != nil {
			return resources.SessionInfo{}, err
		}
		return resources.SessionInfo{Status: session.Status, WorkspaceID: session.WorkspaceID, DeviceID: session.DeviceID, UserID: session.CreatedByUserID}, nil
	}
	return leases
}

// RunResourceLeases recovers the leases kept before a restart, then applies
// their timers until ctx ends.
func (s *Server) RunResourceLeases(ctx context.Context) {
	if err := s.leases.Recover(ctx); err != nil {
		log.Printf("resource leases not recovered: %v", err)
	}
	s.leases.Run(ctx, resourceLeaseSweep)
}

// deviceResourceRouter reaches an instance's hosting worker over its
// daemon connection.
type deviceResourceRouter struct{ hub *DaemonHub }

func (r deviceResourceRouter) operatingConnection(deviceID string) (*daemonConnection, error) {
	connection := r.hub.connectionFor(deviceID)
	if connection == nil {
		return nil, errors.New("the device is not connected")
	}
	if !connection.hasCapability(store.DaemonCapabilityResourceOperations) {
		return nil, errors.New(connection.deviceLabel() + " runs a worker that cannot operate resources yet; update its worker")
	}
	return connection, nil
}

func (r deviceResourceRouter) SendReset(sourceID string, request store.ResourceResetRequest) bool {
	connection, err := r.operatingConnection(sourceID)
	if err != nil {
		return false
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return false
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := daemonRequest[store.ResourceResetResult](ctx, connection, wsResourceResetType, payload)
		if err != nil {
			log.Printf("resource %s reset at generation %d: %v", request.ResourceID, request.Generation, err)
			return
		}
		if err := r.hub.leases.ResetDone(context.Background(), result.ResourceID, result.Generation, result.Error); err != nil {
			log.Printf("resource %s reset not recorded: %v", request.ResourceID, err)
		}
	}()
	return true
}

func (r deviceResourceRouter) Operate(ctx context.Context, sourceID string, request store.ResourceOperateRequest) (store.ResourceOperateResult, error) {
	connection, err := r.operatingConnection(sourceID)
	if err != nil {
		return store.ResourceOperateResult{}, err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return store.ResourceOperateResult{}, err
	}
	return daemonRequest[store.ResourceOperateResult](ctx, connection, wsResourceOperateType, payload)
}

// resourceLeaseReactions follow sessions: a turn that runs keeps its
// leases active, one that ends parks or releases them.
type resourceLeaseReactions struct{ server *Server }

func (r resourceLeaseReactions) sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession) {
	leases := r.server.leases
	var err error
	switch change {
	case sessionQueued, sessionStarted, sessionBlocked, sessionResumed:
		err = leases.TurnStarted(ctx, session.ID)
	case sessionCompleted:
		err = leases.TurnEnded(ctx, session.ID, session.Status)
	}
	if err != nil {
		log.Printf("resource leases of session %s: %v", session.ID, err)
	}
}

// resourceLeasesDeviceConnected fences a reconnected device's worker and
// marks its sessions' leases attended again.
func (s *Server) resourceLeasesDeviceConnected(ctx context.Context, deviceID string, capabilities []string) {
	if err := s.leases.DeviceConnected(ctx, deviceID, slices.Contains(capabilities, store.DaemonCapabilityResourceOperations)); err != nil {
		log.Printf("resource leases on %s connecting: %v", deviceID, err)
	}
	if slices.Contains(capabilities, store.DaemonCapabilityResourceCompute) {
		// Its worker enforces the owner's settings from now on; it keeps
		// what it was last told only until this arrives.
		go func() {
			settings, err := s.resources.Settings(context.Background(), deviceID)
			if err != nil {
				log.Printf("resource settings of %s not read: %v", deviceID, err)
				return
			}
			// A device that just connected may drop and reconnect while
			// this is on its way (seen on 2026-10-13 after a restart): try
			// again on its current connection until one applies it.
			for attempt, wait := 0, time.Second; attempt < 6; attempt, wait = attempt+1, wait*2 {
				if s.sendResourceSettings(context.Background(), deviceID, settings) {
					return
				}
				time.Sleep(wait)
			}
		}()
	}
}

// resourceSettingsTimeout bounds a worker's answer to resource_settings.
const resourceSettingsTimeout = 15 * time.Second

// sendResourceSettings tells a device's worker its owner's settings; true
// once a worker that enforces them (resources_compute_v1) applied them.
func (s *Server) sendResourceSettings(ctx context.Context, deviceID string, settings store.ResourceSourceSettings) bool {
	connection := s.hub.connectionFor(deviceID)
	if connection == nil || !connection.hasCapability(store.DaemonCapabilityResourceCompute) {
		log.Printf("resource settings for %s not sent: no connection with %s", deviceID, store.DaemonCapabilityResourceCompute)
		return false
	}
	payload, err := json.Marshal(settings)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, resourceSettingsTimeout)
	defer cancel()
	applied, err := daemonRequest[store.ResourceSourceSettings](ctx, connection, wsResourceSettingsType, payload)
	if err != nil {
		log.Printf("resource settings not applied on %s: %v", deviceID, err)
		return false
	}
	if applied != settings {
		log.Printf("resource settings on %s: sent %+v, worker applied %+v", deviceID, settings, applied)
		return false
	}
	return true
}

// --- the person's routes ----------------------------------------------

// resourceForOwner reads the instance a route names, answering 404 unless
// the caller owns its device.
func (s *Server) resourceForOwner(w http.ResponseWriter, r *http.Request) (store.ResourceInstance, bool) {
	id := strings.TrimSpace(r.PathValue("id"))
	list, err := s.resources.List(r.Context(), store.ResourceFilter{IncludeGone: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return store.ResourceInstance{}, false
	}
	for _, instance := range list.Instances {
		if instance.ID == id {
			if instance.Source.Kind != "device" || !s.requireDeviceOwner(w, r, instance.Source.ID) {
				if instance.Source.Kind != "device" {
					writeError(w, http.StatusNotFound, "resource not found")
				}
				return store.ResourceInstance{}, false
			}
			return instance, true
		}
	}
	writeError(w, http.StatusNotFound, "resource not found")
	return store.ResourceInstance{}, false
}

// writeLeaseResult answers a lease decision; a refusal is a 409 with its
// words.
func writeLeaseResult(w http.ResponseWriter, payload any, err error) {
	var refusal *resources.LeaseError
	if errors.As(err, &refusal) {
		status := http.StatusConflict
		if refusal.Code == resources.CodeNotFound {
			status = http.StatusNotFound
		}
		writeError(w, status, refusal.Message)
		return
	}
	writeResult(w, payload, err)
}

// handleReleaseResource: the person ends the lease on an instance.
func (s *Server) handleReleaseResource(w http.ResponseWriter, r *http.Request) {
	instance, ok := s.resourceForOwner(w, r)
	if !ok {
		return
	}
	lease, err := s.leases.Revoke(r.Context(), instance.ID, actorFromContext(r.Context()).AccountID())
	writeLeaseResult(w, map[string]any{"lease": lease}, err)
}

// handleLetResourceFinish: the person lets the holder keep an instance
// another session waits for, once more.
func (s *Server) handleLetResourceFinish(w http.ResponseWriter, r *http.Request) {
	instance, ok := s.resourceForOwner(w, r)
	if !ok {
		return
	}
	lease, err := s.leases.LetFinish(r.Context(), instance.ID)
	writeLeaseResult(w, map[string]any{"lease": lease}, err)
}

// handleResourceOperations lists an instance's audited operations.
func (s *Server) handleResourceOperations(w http.ResponseWriter, r *http.Request) {
	instance, ok := s.resourceForOwner(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	records, err := s.leases.Operations(r.Context(), instance.ID, limit)
	writeResult(w, store.ResourceOperationList{Operations: records}, err)
}

// handleStopDeviceResources: the person takes a device back from every
// session using its resources.
func (s *Server) handleStopDeviceResources(w http.ResponseWriter, r *http.Request) {
	released, err := s.leases.StopSource(r.Context(), r.PathValue("deviceId"), actorFromContext(r.Context()).AccountID())
	writeResult(w, map[string]int{"released": released}, err)
}

// handleResourceSettings: a device's owner changes what sessions may do with
// its resources (allowing remote commands). Only the owner's own account
// may: not an administrator of other people's devices, not a device
// credential, never a session. Applied answers whether the device's worker
// enforces it already; otherwise it gets it when it connects.
func (s *Server) handleResourceSettings(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	actor := actorFromContext(r.Context())
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return
	}
	if actor.Kind != ActorAccount || !scope.ownsDevice(deviceID) {
		writeError(w, http.StatusForbidden, "only the device's owner, signed in, changes what sessions may do on it")
		return
	}
	var input store.ResourceSourceSettings
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if err := s.resources.SetSettings(r.Context(), deviceID, input, actor.AccountID()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	applied := s.sendResourceSettings(r.Context(), deviceID, input)
	writeJSON(w, http.StatusOK, map[string]any{"allowRemoteCommands": input.AllowRemoteCommands, "applied": applied})
}

// handleInstallResourceBackend runs a backend's official installer on the
// device, only because its owner asked; nothing is bundled with Foundry.
func (s *Server) handleInstallResourceBackend(w http.ResponseWriter, r *http.Request) {
	var input store.ResourceBackendInstallRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Backend != "cua-driver" {
		writeError(w, http.StatusBadRequest, "unknown backend "+input.Backend+": Foundry installs cua-driver")
		return
	}
	connection, err := deviceResourceRouter{hub: s.hub}.operatingConnection(r.PathValue("deviceId"))
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	payload, err := json.Marshal(input)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), installResourceBackendTimeout+30*time.Second)
	defer cancel()
	result, err := daemonRequest[store.ResourceBackendInstallResult](ctx, connection, wsInstallResourceBackendType, payload)
	writeResult(w, result, err)
}
