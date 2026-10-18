package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Several people on one computer account (docs/devices-and-workspaces.md,
// "一台电脑上的几个人"). One system account belongs to one owner by default.
// A person pairing a worker under an account another person's device uses
// is told plainly that they would share it, and pairs only after choosing
// to (in the terminal or in the web); both devices then say so, the owner
// who was there first gets one notice, sessions on them are told, and the
// Personal Agent does not place work there on its own. Nothing keeps
// anyone apart: it is labelled as sharing, never as isolation.

// sharedAccountMessage is what the terminal shows when pairing waits for
// that choice; the web says the same in the person's language.
func sharedAccountMessage(names []string) string {
	together := "both"
	if len(names) > 1 {
		together = "all"
	}
	return fmt.Sprintf("This computer account is already used by %s in Foundry. If you continue, you share it: you'll %s work with the same files and the same Claude/Codex sign-ins on this account; nothing here keeps your work apart. To have your own separate space, create a separate system account on this computer.",
		joinNames(names), together)
}

func joinNames(names []string) string {
	switch len(names) {
	case 0:
		return "another person"
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// handleDevicePairingStatus answers where the caller's pairing token
// stands, so the Add device dialog can ask for the choice a waiting worker
// needs.
func (s *Server) handleDevicePairingStatus(w http.ResponseWriter, r *http.Request) {
	account, ok := currentAccount(w, r)
	if !ok {
		return
	}
	var input store.DevicePairingStatusRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	status, err := s.store.DevicePairingStatus(r.Context(), accounts.HashToken(strings.TrimSpace(input.Token)), account.ID)
	writePairingStatus(w, status, err)
}

// handleDevicePairingConsent records the caller's choice on a pairing that
// waits for it: continue shares the system account, cancel ends the
// pairing (the worker is told the next time it asks).
func (s *Server) handleDevicePairingConsent(w http.ResponseWriter, r *http.Request) {
	account, ok := currentAccount(w, r)
	if !ok {
		return
	}
	var input store.DevicePairingConsentRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	status, err := s.store.SetDevicePairingConsent(r.Context(), accounts.HashToken(strings.TrimSpace(input.Token)), account.ID, input.Accept)
	writePairingStatus(w, status, err)
}

func writePairingStatus(w http.ResponseWriter, status store.DevicePairingStatus, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "pairing token not found")
		return
	}
	writeResult(w, status, err)
}

// handleDismissSystemAccountNotice: the device's owner read that someone
// else now shares its system account. The label stays.
func (s *Server) handleDismissSystemAccountNotice(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DismissDeviceAccountShareNotice(r.Context(), strings.TrimSpace(r.PathValue("deviceId"))); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.dataChanges.changed("", fieldDevices)
	w.WriteHeader(http.StatusNoContent)
}

// withAccountShares adds to each device the caller owns the other people's
// devices under its system account; nobody else sees them, and nothing a
// worker reported stands in for them.
func (s *Server) withAccountShares(ctx context.Context, devices []store.DeviceProjection) []store.DeviceProjection {
	var shares map[string][]store.DeviceAccountShare
	if slices.ContainsFunc(devices, func(device store.DeviceProjection) bool { return device.Owned }) {
		var err error
		if shares, err = s.store.ListDeviceAccountShares(ctx); err != nil {
			log.Printf("shared system accounts not listed: %v", err)
		}
	}
	for i := range devices {
		devices[i].SharesSystemAccountWith = nil
		if devices[i].Owned {
			devices[i].SharesSystemAccountWith = shares[devices[i].ID]
		}
	}
	return devices
}

// sharedAccountDevices are the devices whose system account other people's
// devices use, with those people's names.
func (s *Server) sharedAccountDevices(ctx context.Context) map[string][]string {
	shares, err := s.store.ListDeviceAccountShares(ctx)
	if err != nil {
		log.Printf("shared system accounts not listed: %v", err)
		return nil
	}
	return shareOwnerNames(shares)
}

func shareOwnerNames(shares map[string][]store.DeviceAccountShare) map[string][]string {
	names := map[string][]string{}
	for deviceID, list := range shares {
		for _, share := range list {
			if !slices.Contains(names[deviceID], share.OwnerName) {
				names[deviceID] = append(names[deviceID], share.OwnerName)
			}
		}
	}
	return names
}

// deviceSharingChanged follows a pairing: who shares which account may
// have changed.
func (s *Server) deviceSharingChanged() {
	go s.hub.accountSharingChanged(context.Background())
}

// recordAccountIdentity keeps the system account a device's worker reports
// and, when it changed, tells everyone concerned.
func (h *DaemonHub) recordAccountIdentity(registration store.DaemonRegistration) {
	if registration.Identity == nil || registration.Device.ID == "" {
		return
	}
	changed, err := h.store.RecordDeviceAccountIdentity(context.Background(), registration.Device.ID, *registration.Identity)
	if err != nil {
		log.Printf("system account of %s not recorded: %v", registration.Device.ID, err)
		return
	}
	if changed {
		go h.accountSharingChanged(context.Background())
	}
}

// accountSharingChanged tells every connected worker that takes it who
// else uses its system account, and browsers to read devices again.
func (h *DaemonHub) accountSharingChanged(ctx context.Context) {
	shares, err := h.store.ListDeviceAccountShares(ctx)
	if err != nil {
		log.Printf("shared system accounts not listed: %v", err)
		return
	}
	names := shareOwnerNames(shares)
	h.mu.Lock()
	connections := make([]*daemonConnection, 0, len(h.connections))
	for _, connection := range h.connections {
		connections = append(connections, connection)
	}
	h.mu.Unlock()
	for _, connection := range connections {
		deviceID, _ := connection.registrationSnapshot()
		connection.sendDeviceSharing(names[deviceID])
	}
	h.dataChanges.changed("", fieldDevices)
}

// sendDeviceSharing tells the worker, if it takes device_sharing, who else
// uses its system account.
func (c *daemonConnection) sendDeviceSharing(names []string) {
	if !c.hasCapability(store.DeviceSharingCapability) {
		return
	}
	payload, err := json.Marshal(store.DeviceSharingPayload{SharedWith: append([]string{}, names...)})
	if err != nil {
		return
	}
	c.queue(wsEnvelope{Type: wsDeviceSharingType, Payload: payload})
}

// observeDeviceSharing tells each device that says hello who else uses its
// system account.
func (s *Server) observeDeviceSharing() {
	connected := s.hub.onDeviceConnected
	s.hub.onDeviceConnected = func(ctx context.Context, deviceID string, capabilities []string) {
		if connected != nil {
			connected(ctx, deviceID, capabilities)
		}
		if !slices.Contains(capabilities, store.DeviceSharingCapability) {
			return
		}
		if connection := s.hub.connectionFor(deviceID); connection != nil {
			connection.sendDeviceSharing(s.sharedAccountDevices(ctx)[deviceID])
		}
	}
}
