package httpapi

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handlePersonalAgentPermissionPackage(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	pkg, err := s.store.GetPermissionPackage(r.Context(), agent.UserID, agent.PermissionPackageID)
	writeResult(w, pkg, err)
}

func (s *Server) handleSavePersonalAgentPermissionPackage(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var pkg store.PermissionPackage
	if !decodeJSONRequest(w, r, &pkg) {
		return
	}
	pkg.ID = agent.PermissionPackageID
	pkg.Owner = agent.UserID
	saved, err := s.store.SavePermissionPackage(r.Context(), pkg)
	writeResult(w, saved, err)
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
	var input store.SetPersonalAgentConnectorLevelsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	levels := map[string]string{}
	for _, level := range input.Levels {
		accountID := strings.TrimSpace(level.AccountID)
		if accountID == "" {
			continue
		}
		levels[accountID] = level.Level
	}
	for _, accountID := range input.Disabled {
		accountID = strings.TrimSpace(accountID)
		if accountID != "" {
			levels[accountID] = store.ConnectorAccessLevelOff
		}
	}
	clean := make([]store.ConnectorAccountPermission, 0, len(levels))
	for accountID, level := range levels {
		clean = append(clean, store.ConnectorAccountPermission{AccountID: accountID, Level: level})
	}
	sort.Slice(clean, func(i, j int) bool { return clean[i].AccountID < clean[j].AccountID })
	agent, err := s.store.SetPersonalAgentConnectorLevels(r.Context(), agent.UserID, clean)
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

func (s *Server) personalAgentConnectors(ctx context.Context, agent store.PersonalAgent) (store.PersonalAgentConnectorsView, error) {
	view := store.PersonalAgentConnectorsView{Connectors: []store.PersonalAgentConnector{}}
	pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return view, err
	}
	levels := map[string]string{}
	for _, account := range pkg.ConnectorAccounts {
		levels[account.AccountID] = account.Level
	}
	levelOf := func(accountID string) string {
		if level := levels[accountID]; level != "" {
			return level
		}
		return store.ConnectorAccessLevelWrite
	}
	accounts, err := s.connectors.ServerHeld.AccountsIncludingExtensions(ctx, agent.UserID)
	if err != nil {
		return view, err
	}
	for _, account := range accounts {
		level := levelOf(account.ID)
		view.Connectors = append(view.Connectors, store.PersonalAgentConnector{
			ID: account.ID, Kind: account.Provider, Label: account.Label,
			Holding: store.ConnectorServerHeld, Status: string(account.Status),
			Level: level, Enabled: level != store.ConnectorAccessLevelOff,
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
		level := levelOf(accountID)
		view.Connectors = append(view.Connectors, store.PersonalAgentConnector{
			ID: accountID, Kind: state.Kind, Label: label, Holding: store.ConnectorDeviceHeld,
			DeviceID: state.DeviceID, DeviceName: names[state.DeviceID], Status: state.Status,
			Level: level, Enabled: level != store.ConnectorAccessLevelOff,
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
