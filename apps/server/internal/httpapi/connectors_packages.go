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

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
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
	for _, id := range enabled.Selected {
		selected[id] = true
	}
	installed := map[string]bool{}
	for _, id := range enabled.Devices {
		installed[id] = true
	}
	instances, err := s.connectorPackageInstances(ctx, ownerUserID, descriptor, devices)
	if err != nil {
		return store.ConnectorPackageView{}, err
	}
	view.Instances = instances
	for _, device := range devices {
		online := s.hub.connectionFor(device.ID) != nil
		eligible, reason := s.connectorPackageDeviceEligible(ctx, device, descriptor, online)
		entry := store.ConnectorPackageDevice{
			DeviceID: device.ID,
			Name:     device.Label,
			Online:   online,
			Selected: selected[device.ID],
			Eligible: eligible,
			Reason:   reason,
		}
		if instances != nil {
			entry.Instances = instancesOnDevice(instances, device.ID)
			if eligible && len(entry.Instances) == 0 {
				entry.Eligible, entry.Reason, entry.ReasonCode = false, noInstanceReason, store.ConnectorPackageDeviceReasonCodeNoInstance
			}
		}
		if progress, ok := enabled.States[device.ID]; ok {
			entry.State, entry.Error = progress.State, progress.Error
		} else if installed[device.ID] {
			entry.State = store.ConnectorPackageDeviceStateInstalled
		}
		view.Devices = append(view.Devices, entry)
	}
	return view, nil
}

const noInstanceReason = "No instance of this connector can be used on this device."

// connectorPackageInstances lists a server-held connector's Ready instances
// and the devices whose sessions can use each: every device for the server
// network, the devices whose probe reached it for the device network. It is nil
// for connectors without instances, which never need one.
func (s *Server) connectorPackageInstances(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, devices []store.DeviceProjection) ([]store.ConnectorPackageInstance, error) {
	if descriptor.Holding != store.ConnectorServerHeld || descriptor.ServerHeld == nil || s.connectors == nil || s.connectors.ServerHeld == nil {
		return nil, nil
	}
	listed, err := s.connectors.ServerHeld.ListExtensionInstances(ctx, ownerUserID, descriptor.Kind)
	if err != nil {
		return nil, err
	}
	return usablePackageInstances(listed, devices), nil
}

func usablePackageInstances(listed []store.ConnectorServerHeldInstance, devices []store.DeviceProjection) []store.ConnectorPackageInstance {
	instances := []store.ConnectorPackageInstance{}
	for _, instance := range listed {
		if instance.Status != string(store.ExternalAccountReady) && instance.Status != string(store.ExternalAccountExpiring) {
			continue
		}
		usable := store.ConnectorPackageInstance{ID: instance.ID, Label: instance.Label, Network: instance.Network, DeviceIDs: []string{}}
		if instance.Network == externalaccounts.ExtensionNetworkDevice {
			for _, check := range instance.AvailableDevices {
				if check.Status == "ok" {
					usable.DeviceIDs = append(usable.DeviceIDs, check.DeviceID)
				}
			}
		} else {
			for _, device := range devices {
				usable.DeviceIDs = append(usable.DeviceIDs, device.ID)
			}
		}
		instances = append(instances, usable)
	}
	return instances
}

func instancesOnDevice(instances []store.ConnectorPackageInstance, deviceID string) []store.ConnectorPackageInstanceRef {
	refs := []store.ConnectorPackageInstanceRef{}
	for _, instance := range instances {
		for _, id := range instance.DeviceIDs {
			if id == deviceID {
				refs = append(refs, store.ConnectorPackageInstanceRef{ID: instance.ID, Label: instance.Label})
				break
			}
		}
	}
	return refs
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
	if _, reason := s.connectorPackageReader(ctx, device, via); reason != "" {
		return false, reason
	}
	return true, ""
}

// connectorPackageReader is the device that reads the package's upstream for
// the target: the target itself when its connector can, else another device
// of the same person whose connector can (the target then only needs the
// platform and network; it never needs the person's sign-in). With no such
// device the reason is the target's own, so the person sees what to connect.
func (s *Server) connectorPackageReader(ctx context.Context, target store.DeviceProjection, via string) (store.DeviceProjection, string) {
	ready, reason := s.deviceConnectorReady(ctx, target.ID, via)
	if ready {
		return target, ""
	}
	if owner, err := s.store.DeviceOwner(ctx, target.ID); err == nil && owner != "" {
		if devices, err := s.ownDevices(ctx, owner); err == nil {
			for _, other := range devices {
				if other.ID == target.ID || s.hub.connectionFor(other.ID) == nil {
					continue
				}
				if ok, _ := s.deviceConnectorReady(ctx, other.ID, via); ok {
					return other, ""
				}
			}
		}
	}
	return store.DeviceProjection{}, reason
}

// deviceConnectorReady says whether a device's connector can be used now,
// and if not, what to do about it.
func (s *Server) deviceConnectorReady(ctx context.Context, deviceID, via string) (bool, string) {
	connector, err := s.connectors.Devices.ConnectorOn(ctx, deviceID, via)
	if err != nil {
		return false, fmt.Sprintf("The %s connector is not available on this device.", via)
	}
	states, err := s.connectors.Devices.States(ctx, []string{deviceID})
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
		return false, fmt.Sprintf("Install the %s connector on this device, or on another device of yours that can read the package's repository.", connector.Label)
	}
	if !state.SignedIn {
		return false, fmt.Sprintf("Sign in to the %s connector on this device, or on another device of yours that can read the package's repository.", connector.Label)
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
	view, err := s.setConnectorPackageDeviceSelection(r.Context(), actor.AccountID(), descriptor, devices, input.DeviceIDs)
	if err != nil {
		if errorStatus(err) != 0 {
			writeResult(w, nil, err)
			return
		}
		writeDeviceConnectorError(w, "Enabling "+descriptor.Label, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func connectorPackageDeviceIDs(ids []string) []string {
	wanted := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		wanted = append(wanted, id)
	}
	return wanted
}

// setConnectorPackageDeviceSelection applies one desired device set after the
// same ownership, eligibility and offline checks the Web page uses.
func (s *Server) setConnectorPackageDeviceSelection(
	ctx context.Context,
	ownerUserID string,
	descriptor store.ConnectorDescriptor,
	devices []store.DeviceProjection,
	deviceIDs []string,
) (store.ConnectorPackageView, error) {
	wanted := connectorPackageDeviceIDs(deviceIDs)
	if len(wanted) == 0 {
		return store.ConnectorPackageView{}, &statusError{http.StatusBadRequest, errors.New("select at least one device, or delete the package enablement")}
	}
	byID := map[string]store.DeviceProjection{}
	for _, device := range devices {
		byID[device.ID] = device
	}
	current, currentErr := s.store.GetConnectorPackage(ctx, ownerUserID, descriptor.Kind)
	if currentErr != nil && !errors.Is(currentErr, store.ErrNotFound) {
		return store.ConnectorPackageView{}, currentErr
	}
	currentSet := map[string]bool{}
	for _, id := range current.Devices {
		currentSet[id] = true
	}
	wantedSet := map[string]bool{}
	for _, id := range wanted {
		wantedSet[id] = true
		device, ok := byID[id]
		if !ok {
			return store.ConnectorPackageView{}, &statusError{http.StatusBadRequest, errors.New("a selected device does not belong to you")}
		}
		if currentSet[id] {
			if s.hub.connectionFor(id) == nil {
				return store.ConnectorPackageView{}, &statusError{http.StatusBadRequest, fmt.Errorf("%s is offline; reconnect it before changing the package", device.Label)}
			}
			continue
		}
		online := s.hub.connectionFor(id) != nil
		if eligible, reason := s.connectorPackageDeviceEligible(ctx, device, descriptor, online); !eligible {
			return store.ConnectorPackageView{}, &statusError{http.StatusBadRequest, fmt.Errorf("%s: %s", device.Label, reason)}
		}
		instances, instancesErr := s.connectorPackageInstances(ctx, ownerUserID, descriptor, devices)
		if instancesErr != nil {
			return store.ConnectorPackageView{}, instancesErr
		}
		if instances != nil && len(instancesOnDevice(instances, id)) == 0 {
			return store.ConnectorPackageView{}, &statusError{http.StatusBadRequest, fmt.Errorf("%s: %s", device.Label, noInstanceReason)}
		}
	}
	for _, id := range current.Devices {
		if wantedSet[id] {
			continue
		}
		device, ok := byID[id]
		if !ok {
			return store.ConnectorPackageView{}, &statusError{http.StatusBadRequest, errors.New("a selected device no longer belongs to you")}
		}
		if s.hub.connectionFor(id) == nil {
			return store.ConnectorPackageView{}, &statusError{http.StatusBadRequest, fmt.Errorf("%s is offline; reconnect it before removing the package", device.Label)}
		}
	}
	if err := s.selectConnectorPackageDevices(ctx, ownerUserID, descriptor, wanted); err != nil {
		return store.ConnectorPackageView{}, err
	}
	s.projectionsChanged("", fieldConnectorPackages)
	s.startConnectorPackageApply(ownerUserID, descriptor.Kind)
	return s.connectorPackageView(context.WithoutCancel(ctx), ownerUserID, descriptor, devices)
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
	if _, err := s.removeConnectorPackage(r.Context(), actor.AccountID(), descriptor); err != nil {
		if errorStatus(err) != 0 {
			writeResult(w, nil, err)
			return
		}
		writeDeviceConnectorError(w, "Disabling "+descriptor.Label, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"kind": kind})
}

// connectorPackageReaderFor picks the reader of a package's upstream for
// enabling it, preferring the first selected device that can read it itself.
func (s *Server) connectorPackageReaderFor(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, firstDeviceID string) (store.DeviceProjection, error) {
	devices, err := s.ownDevices(ctx, ownerUserID)
	if err != nil {
		return store.DeviceProjection{}, err
	}
	for _, device := range devices {
		if device.ID != firstDeviceID {
			continue
		}
		reader, reason := s.connectorPackageReader(ctx, device, descriptor.Package.Upstream.Via)
		if reason != "" {
			return store.DeviceProjection{}, &statusError{http.StatusBadRequest, errors.New(reason)}
		}
		return reader, nil
	}
	return store.DeviceProjection{}, &statusError{http.StatusBadRequest, errors.New("a selected device does not belong to you")}
}

func (s *Server) followConnectorPackageBundle(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, readerDevice store.DeviceProjection) (store.SkillRepository, error) {
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
		FetchDeviceID: readerDevice.ID, FetchDeviceName: readerDevice.Label,
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
		FetchDeviceID: readerDevice.ID, FetchDeviceName: readerDevice.Label,
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
		_, err := s.installBundleToolOnDevice(ctx, deviceID, repository.FetchDeviceID, tool, "install")
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
		if _, err := s.installBundleToolOnDevice(ctx, deviceID, repository.FetchDeviceID, uninstall, "uninstall"); err != nil {
			return fmt.Errorf("uninstalling %s: %w", tool.Name, err)
		}
		if err := s.store.SetDeviceToolVersion(ctx, deviceID, tool.Name, ""); err != nil {
			return err
		}
	}
	return nil
}
