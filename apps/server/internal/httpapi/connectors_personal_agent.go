package httpapi

import (
	"context"
	"net/http"
	"sort"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type personalAgentConnector struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Label      string `json:"label"`
	Holding    string `json:"holding"`
	DeviceID   string `json:"deviceId,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	Status     string `json:"status,omitempty"`
	Enabled    bool   `json:"enabled"`
}

type personalAgentConnectorsView struct {
	Connectors []personalAgentConnector `json:"connectors"`
}

type setPersonalAgentConnectorsInput struct {
	Disabled []string `json:"disabled"`
}

func (s *Server) handlePersonalAgentConnectors(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	view, err := s.personalAgentConnectors(r.Context(), agent)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleSetPersonalAgentConnectors(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input setPersonalAgentConnectorsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	agent, err := s.store.SetPersonalAgentConnectorOptOut(r.Context(), agent.UserID, input.Disabled)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.personalAgentConnectors(r.Context(), agent)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) personalAgentConnectors(ctx context.Context, agent store.PersonalAgent) (personalAgentConnectorsView, error) {
	view := personalAgentConnectorsView{Connectors: []personalAgentConnector{}}
	disabled := make(map[string]bool, len(agent.ConnectorOptOut))
	for _, accountID := range agent.ConnectorOptOut {
		disabled[accountID] = true
	}
	accounts, err := s.connectors.ServerHeld.Accounts(ctx, agent.UserID)
	if err != nil {
		return view, err
	}
	for _, account := range accounts {
		view.Connectors = append(view.Connectors, personalAgentConnector{
			ID: account.ID, Kind: account.Provider, Label: account.Label,
			Holding: store.ConnectorServerHeld, Status: string(account.Status), Enabled: !disabled[account.ID],
		})
	}
	devices, err := s.ownDevices(ctx, agent.UserID)
	if err != nil {
		return view, err
	}
	ids := make([]string, 0, len(devices))
	names := make(map[string]string, len(devices))
	for _, device := range devices {
		ids = append(ids, device.ID)
		names[device.ID] = device.Label
	}
	descriptors, _, err := s.connectors.Devices.ConnectorsFor(ctx, ids)
	if err != nil {
		return view, err
	}
	byKind := make(map[string]store.ConnectorDescriptor, len(descriptors))
	for _, descriptor := range descriptors {
		byKind[descriptor.Kind] = descriptor
	}
	states, err := s.connectors.Devices.States(ctx, ids)
	if err != nil {
		return view, err
	}
	for _, state := range states {
		accountID := externalaccounts.DeviceAccountID(state.DeviceID, state.Kind)
		descriptor := byKind[state.Kind]
		label := descriptor.Label
		if label == "" {
			label = state.Kind
		}
		view.Connectors = append(view.Connectors, personalAgentConnector{
			ID: accountID, Kind: state.Kind, Label: label, Holding: store.ConnectorDeviceHeld,
			DeviceID: state.DeviceID, DeviceName: names[state.DeviceID], Status: state.Status, Enabled: !disabled[accountID],
		})
	}
	sort.Slice(view.Connectors, func(i, j int) bool {
		if view.Connectors[i].Holding != view.Connectors[j].Holding {
			return view.Connectors[i].Holding < view.Connectors[j].Holding
		}
		if view.Connectors[i].Label != view.Connectors[j].Label {
			return view.Connectors[i].Label < view.Connectors[j].Label
		}
		return view.Connectors[i].ID < view.Connectors[j].ID
	})
	return view, nil
}
