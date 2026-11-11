package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Connector packages are the person-level link between a connector, its
// upstream Skill bundle, and the devices where the bundle's CLIs are
// installed. Bundle versions and rollouts remain in the Skill library.

func (s *Server) packageDescriptors(ctx context.Context, userID string) ([]store.ConnectorDescriptor, []store.DeviceProjection, error) {
	devices, err := s.ownDevices(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]string, 0, len(devices))
	for _, device := range devices {
		ids = append(ids, device.ID)
	}
	listed, err := s.connectors.Devices.ExtensionDescriptorsFor(ctx, ids)
	if err != nil {
		return nil, nil, err
	}
	byKind := map[string]store.ConnectorDescriptor{}
	for _, onDevice := range listed {
		for _, descriptor := range onDevice {
			if descriptor.Package == nil || descriptor.Extension == nil {
				continue
			}
			if current, ok := byKind[descriptor.Kind]; !ok || descriptor.Extension != nil && current.Extension != nil && connectorVersionNewer(descriptor.Extension.Version, current.Extension.Version) {
				byKind[descriptor.Kind] = descriptor
			}
		}
	}
	kinds := make([]string, 0, len(byKind))
	for kind := range byKind {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	packages := make([]store.ConnectorDescriptor, 0, len(kinds))
	for _, kind := range kinds {
		packages = append(packages, byKind[kind])
	}
	return packages, devices, nil
}

func connectorVersionNewer(a, b string) bool {
	parts := func(value string) []int {
		var out []int
		current := 0
		digits := false
		for _, r := range value {
			if r >= '0' && r <= '9' {
				current = current*10 + int(r-'0')
				digits = true
				continue
			}
			if digits {
				out = append(out, current)
			}
			current, digits = 0, false
			if r != '.' {
				break
			}
		}
		if digits {
			out = append(out, current)
		}
		return out
	}
	left, right := parts(a), parts(b)
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] != right[i] {
			return left[i] > right[i]
		}
	}
	return len(left) > len(right)
}

func (s *Server) connectorPackageView(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, devices []store.DeviceProjection) (store.ConnectorPackageView, error) {
	enabled, err := s.store.GetConnectorPackage(ctx, ownerUserID, descriptor.Kind)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return store.ConnectorPackageView{}, err
	}
	view := store.ConnectorPackageView{
		Connector: descriptor,
		Enabled:   err == nil,
		Devices:   []store.ConnectorPackageDevice{},
	}
	if err == nil {
		view.RepositoryID = enabled.RepositoryID
	}
	selected := map[string]bool{}
	for _, id := range enabled.Devices {
		selected[id] = true
	}
	for _, device := range devices {
		online := s.hub.connectionFor(device.ID) != nil
		eligible, reason := s.connectorPackageDeviceEligible(ctx, device, descriptor, online)
		view.Devices = append(view.Devices, store.ConnectorPackageDevice{
			DeviceID: device.ID,
			Name:     device.Label,
			Online:   online,
			Selected: selected[device.ID],
			Eligible: eligible,
			Reason:   reason,
		})
	}
	return view, nil
}

func (s *Server) connectorPackageDeviceEligible(ctx context.Context, device store.DeviceProjection, descriptor store.ConnectorDescriptor, online bool) (bool, string) {
	if !online {
		return false, "The device is offline."
	}
	if device.System == nil || device.System.OS == "" {
		return false, "The device has not reported a supported platform."
	}
	osName := strings.ToLower(device.System.OS)
	if !strings.Contains(osName, "linux") && !strings.Contains(osName, "mac") && !strings.Contains(osName, "darwin") {
		return false, "Foundry tools are supported on Linux and macOS only."
	}
	if device.System.NodeVersion == "" {
		return false, "This device has no Node.js runtime for repository tools."
	}
	via := descriptor.Package.Upstream.Via
	if via == "" {
		return false, "The package names no repository-reading connector."
	}
	connector, err := s.connectors.Devices.ConnectorOn(ctx, device.ID, via)
	if err != nil {
		return false, fmt.Sprintf("The %s connector is not available on this device.", via)
	}
	states, err := s.connectors.Devices.States(ctx, []string{device.ID})
	if err != nil {
		return false, "The device's connector state could not be read."
	}
	var state *store.DeviceConnectorState
	for i := range states {
		if states[i].Kind == via {
			state = &states[i]
			break
		}
	}
	if state == nil || !state.Installed {
		return false, fmt.Sprintf("Install the %s connector on this device.", connector.Label)
	}
	if !state.SignedIn {
		return false, fmt.Sprintf("Sign in to the %s connector on this device.", connector.Label)
	}
	if state.Status != store.DeviceConnectorReady && state.Status != store.DeviceConnectorExpiring {
		if state.StatusDetail != "" {
			return false, state.StatusDetail
		}
		return false, fmt.Sprintf("The %s connector is not ready on this device.", connector.Label)
	}
	return true, ""
}

func (s *Server) handleListConnectorPackages(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	descriptors, devices, err := s.packageDescriptors(r.Context(), actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	views := make([]store.ConnectorPackageView, 0, len(descriptors))
	for _, descriptor := range descriptors {
		view, err := s.connectorPackageView(r.Context(), actor.AccountID(), descriptor, devices)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		views = append(views, view)
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) packageDescriptorForOwner(ctx context.Context, userID, kind string) (store.ConnectorDescriptor, []store.DeviceProjection, error) {
	descriptors, devices, err := s.packageDescriptors(ctx, userID)
	if err != nil {
		return store.ConnectorDescriptor{}, nil, err
	}
	for _, descriptor := range descriptors {
		if descriptor.Kind == kind {
			return descriptor, devices, nil
		}
	}
	return store.ConnectorDescriptor{}, nil, store.ErrNotFound
}

func (s *Server) handleGetConnectorPackage(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	kind := strings.TrimSpace(r.PathValue("kind"))
	descriptor, devices, err := s.packageDescriptorForOwner(r.Context(), actor.AccountID(), kind)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "connector package not found")
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.connectorPackageView(r.Context(), actor.AccountID(), descriptor, devices)
	writeResult(w, view, err)
}

func (s *Server) handleSetConnectorPackageDevices(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.SetConnectorPackageDevicesInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	kind := strings.TrimSpace(r.PathValue("kind"))
	descriptor, devices, err := s.packageDescriptorForOwner(r.Context(), actor.AccountID(), kind)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "connector package not found")
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	wanted := make([]string, 0, len(input.DeviceIDs))
	seen := map[string]bool{}
	for _, raw := range input.DeviceIDs {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		wanted = append(wanted, id)
	}
	if len(wanted) == 0 {
		writeError(w, http.StatusBadRequest, "select at least one device, or delete the package enablement")
		return
	}
	byID := map[string]store.DeviceProjection{}
	for _, device := range devices {
		byID[device.ID] = device
	}
	current, currentErr := s.store.GetConnectorPackage(r.Context(), actor.AccountID(), kind)
	if currentErr != nil && !errors.Is(currentErr, store.ErrNotFound) {
		writeResult(w, nil, currentErr)
		return
	}
	currentSet := map[string]bool{}
	for _, id := range current.Devices {
		currentSet[id] = true
	}
	for _, id := range wanted {
		device, ok := byID[id]
		if !ok {
			writeError(w, http.StatusBadRequest, "a selected device does not belong to you")
			return
		}
		if currentSet[id] {
			if s.hub.connectionFor(id) == nil {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("%s is offline; reconnect it before changing the package", device.Label))
				return
			}
			continue
		}
		online := s.hub.connectionFor(id) != nil
		if eligible, reason := s.connectorPackageDeviceEligible(r.Context(), device, descriptor, online); !eligible {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("%s: %s", device.Label, reason))
			return
		}
	}
	for _, id := range current.Devices {
		if seen[id] {
			continue
		}
		if s.hub.connectionFor(id) == nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("%s is offline; reconnect it before removing the package", byID[id].Label))
			return
		}
	}
	_, err = s.applyConnectorPackageDevices(r.Context(), actor.AccountID(), descriptor, wanted)
	if err != nil {
		writeDeviceConnectorError(w, "Enabling "+descriptor.Label, err)
		return
	}
	s.projectionsChanged("", fieldConnectorPackages)
	view, err := s.connectorPackageView(context.WithoutCancel(r.Context()), actor.AccountID(), descriptor, devices)
	writeResult(w, view, err)
}

func (s *Server) handleDeleteConnectorPackage(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	kind := strings.TrimSpace(r.PathValue("kind"))
	descriptor, _, descriptorErr := s.packageDescriptorForOwner(r.Context(), actor.AccountID(), kind)
	current, err := s.store.GetConnectorPackage(r.Context(), actor.AccountID(), kind)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]string{"kind": kind})
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if errors.Is(descriptorErr, store.ErrNotFound) {
		descriptor = store.ConnectorDescriptor{Kind: current.Kind, Label: current.Kind}
	} else if descriptorErr != nil {
		writeResult(w, nil, descriptorErr)
		return
	}
	if err := s.disableConnectorPackageDevices(r.Context(), actor.AccountID(), descriptor, current.Devices); err != nil {
		writeDeviceConnectorError(w, "Disabling "+descriptor.Label, err)
		return
	}
	if err := s.store.DeleteConnectorPackage(r.Context(), actor.AccountID(), kind); err != nil && !errors.Is(err, store.ErrNotFound) {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged("", fieldConnectorPackages)
	writeJSON(w, http.StatusOK, map[string]string{"kind": kind})
}

func (s *Server) applyConnectorPackageDevices(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, wanted []string) (store.ConnectorPackageEnablement, error) {
	s.repoMu.Lock()
	defer s.repoMu.Unlock()
	current, err := s.store.GetConnectorPackage(ctx, ownerUserID, descriptor.Kind)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return store.ConnectorPackageEnablement{}, err
	}
	currentSet := map[string]bool{}
	for _, id := range current.Devices {
		currentSet[id] = true
	}
	wantedSet := map[string]bool{}
	var additions, removals []string
	for _, id := range wanted {
		wantedSet[id] = true
		if !currentSet[id] {
			additions = append(additions, id)
		}
	}
	for _, id := range current.Devices {
		if !wantedSet[id] {
			removals = append(removals, id)
		}
	}
	repository, err := s.followConnectorPackageBundle(ctx, ownerUserID, descriptor, wanted[0])
	if err != nil {
		return store.ConnectorPackageEnablement{}, err
	}
	installed := []string{}
	rollbackAdded := func() {
		for _, id := range installed {
			_ = s.uninstallPackageTools(context.WithoutCancel(ctx), id, repository)
		}
	}
	for _, id := range additions {
		if err := s.enableConnectorPackageDevice(ctx, id, descriptor, repository); err != nil {
			rollbackAdded()
			return store.ConnectorPackageEnablement{}, err
		}
		installed = append(installed, id)
	}
	if err := s.disableConnectorPackageDevices(ctx, ownerUserID, descriptor, removals); err != nil {
		rollbackAdded()
		return store.ConnectorPackageEnablement{}, err
	}
	updated := store.ConnectorPackageEnablement{
		OwnerUserID: ownerUserID, Kind: descriptor.Kind,
		ExtensionID: descriptor.Extension.ID, RepositoryID: repository.ID,
		Devices:   append([]string(nil), wanted...),
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.store.SaveConnectorPackage(ctx, updated); err != nil {
		rollbackAdded()
		for _, id := range removals {
			_ = s.enableConnectorPackageDevice(ctx, id, descriptor, repository)
		}
		return store.ConnectorPackageEnablement{}, err
	}
	return updated, nil
}

func (s *Server) followConnectorPackageBundle(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, readerDeviceID string) (store.SkillRepository, error) {
	remote, _, err := skillrepo.NormalizeURL(descriptor.Package.Upstream.Repository)
	if err != nil {
		return store.SkillRepository{}, err
	}
	tools := connectorPackageTools(*descriptor.Package)
	repos, err := s.store.ListSkillRepositories(ctx)
	if err != nil {
		return store.SkillRepository{}, err
	}
	for _, repo := range repos {
		if repo.URL != remote || repo.Ref != descriptor.Package.Upstream.Ref || repo.Subpath != descriptor.Package.Skills.Path {
			continue
		}
		if repo.Mode != "bundle" {
			return store.SkillRepository{}, errors.New("the package upstream is already followed by picking skills; it cannot become this package's bundle")
		}
		if !sameDeclaredTools(repo.DeclaredTools, tools) {
			return store.SkillRepository{}, errors.New("the package upstream bundle has different tool declarations; not overwriting them")
		}
		return repo, nil
	}
	source := store.SkillRepository{
		FetchDeviceID: readerDeviceID, FetchDeviceName: readerDeviceID,
		Subpath:       descriptor.Package.Skills.Path,
		DeclaredTools: tools,
	}
	reader := s.sourceFor(source)
	fetchRef, _, version, err := s.bundleTarget(ctx, reader, remote, descriptor.Package.Upstream.Ref)
	if err != nil {
		return store.SkillRepository{}, err
	}
	checkout, err := reader.Fetch(ctx, remote, fetchRef)
	if err != nil {
		return store.SkillRepository{}, err
	}
	defer checkout.Close()
	found, err := checkout.FindSkills(descriptor.Package.Skills.Path)
	if err != nil || len(found) == 0 {
		return store.SkillRepository{}, errors.New("the package has no Skill folder at its upstream path")
	}
	created, err := s.store.CreateSkillRepository(ctx, store.SkillRepository{
		URL: remote, Label: descriptor.Package.Upstream.Repository,
		Ref: descriptor.Package.Upstream.Ref, Subpath: descriptor.Package.Skills.Path,
		Mode: "bundle", Name: descriptor.Extension.Name, DeclaredTools: tools,
		FetchDeviceID: readerDeviceID, FetchDeviceName: readerDeviceID,
	}, ownerUserID)
	if err != nil {
		return store.SkillRepository{}, err
	}
	if _, err := s.applyBundle(ctx, created, checkout, version, false); err != nil {
		_ = s.store.DeleteSkillRepository(ctx, created.ID)
		return store.SkillRepository{}, err
	}
	created.Version = version
	created.Commit = checkout.Commit
	return s.store.GetSkillRepository(ctx, created.ID)
}

func connectorPackageTools(spec store.ConnectorPackage) []store.SkillToolDeclaration {
	tools := make([]store.SkillToolDeclaration, 0, len(spec.Tools))
	for _, tool := range spec.Tools {
		bins := map[string]string{}
		for name, path := range tool.Bins {
			bins[name] = path
		}
		tools = append(tools, store.SkillToolDeclaration{
			Source: tool.Source, Command: tool.Command, Path: tool.Path, Bins: bins,
		})
	}
	return tools
}

func sameDeclaredTools(left, right []store.SkillToolDeclaration) bool {
	if len(left) != len(right) {
		return false
	}
	encoded := func(tools []store.SkillToolDeclaration) string {
		value, _ := json.Marshal(tools)
		return string(value)
	}
	return encoded(left) == encoded(right)
}

func (s *Server) enableConnectorPackageDevice(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor, repository store.SkillRepository) error {
	for _, tool := range repository.Tools {
		_, err := s.installBundleToolOnDevice(ctx, deviceID, tool, "install")
		if err != nil {
			return fmt.Errorf("installing %s: %w", tool.Name, err)
		}
		if err := s.store.SetDeviceToolVersion(ctx, deviceID, tool.Name, tool.Version); err != nil {
			return err
		}
	}
	if err := s.ensureConnectorPackageExtension(ctx, deviceID, descriptor); err != nil {
		return err
	}
	s.syncConnectorToolVersions(ctx)
	s.projectionsChanged("", fieldDeviceTools)
	return nil
}

func (s *Server) ensureConnectorPackageExtension(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor) error {
	on, err := s.connectors.Devices.ExtensionDescriptorsFor(ctx, []string{deviceID})
	if err != nil {
		return err
	}
	for _, installed := range on[deviceID] {
		if installed.Kind == descriptor.Kind && installed.Extension != nil &&
			installed.Extension.ID == descriptor.Extension.ID &&
			installed.Extension.State != "available" {
			return nil
		}
	}
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return errors.New("the device is offline")
	}
	payload, _ := json.Marshal(map[string]any{
		"action":             "install",
		"bundledExtensionId": descriptor.Extension.ID,
	})
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	reply, err := daemonRequest[store.ExtensionReplyPayload](callCtx, connection, wsExtensionRequestType, payload)
	if err != nil {
		return err
	}
	if reply.Error != "" {
		return errors.New(reply.Error)
	}
	if reply.Action != "created" && reply.Action != "updated" && reply.Action != "unchanged" {
		return errors.New("the worker did not confirm the bundled extension install")
	}
	return nil
}

func (s *Server) disableConnectorPackageDevices(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, devices []string) error {
	if len(devices) == 0 {
		return nil
	}
	current, err := s.store.ListConnectorPackages(ctx, ownerUserID)
	if err != nil {
		return err
	}
	var repository store.SkillRepository
	found := false
	for _, item := range current {
		if item.Kind == descriptor.Kind {
			repository, err = s.store.GetSkillRepository(ctx, item.RepositoryID)
			if err != nil {
				return err
			}
			found = true
			break
		}
	}
	if !found {
		return errors.New("the package has no followed bundle")
	}
	for _, deviceID := range devices {
		if err := s.uninstallPackageTools(ctx, deviceID, repository); err != nil {
			return err
		}
	}
	s.syncConnectorToolVersions(ctx)
	s.projectionsChanged("", fieldDeviceTools)
	return nil
}

func (s *Server) uninstallPackageTools(ctx context.Context, deviceID string, repository store.SkillRepository) error {
	reported, _ := s.store.ListDeviceTools(ctx, deviceID)
	installed := map[string]string{}
	for _, item := range reported {
		if item.Version != "" {
			installed[item.Tool] = item.Version
		}
	}
	for _, tool := range repository.Tools {
		uninstall := tool
		if version := installed[tool.Name]; version != "" {
			uninstall.Version = version
		}
		if _, err := s.installBundleToolOnDevice(ctx, deviceID, uninstall, "uninstall"); err != nil {
			return fmt.Errorf("uninstalling %s: %w", tool.Name, err)
		}
		if err := s.store.SetDeviceToolVersion(ctx, deviceID, tool.Name, ""); err != nil {
			return err
		}
	}
	return nil
}
