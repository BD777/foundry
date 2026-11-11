package connectors

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Connector extensions (docs/connector-extensions.md): a device's owner
// installs an extension on the device, and its worker reports the
// connectors it provides with every registration. The server keeps them on
// the device's record and treats each as a device-held connector of that
// device only: never offered on another device, never shown to anyone but
// the device's owner.

var extensionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// maxExtensionConnectors bounds what one device may report.
const maxExtensionConnectors = 16

// ExtensionConnectors keeps the well-formed connectors among those a device
// reported for its extensions: server- or device-held, adapter
// "extension:<id>" with the extension named, a kind no built-in connector
// has, each kind once.
func (c *Catalog) ExtensionConnectors(reported []store.ConnectorDescriptor) []store.ConnectorDescriptor {
	kept, _ := c.ExtensionConnectorsWithErrors(reported)
	return kept
}

// ExtensionConnectorsWithErrors keeps valid connectors and explains every
// refused descriptor for the device page and the server log.
func (c *Catalog) ExtensionConnectorsWithErrors(reported []store.ConnectorDescriptor) ([]store.ConnectorDescriptor, []store.ConnectorExtensionError) {
	var kept []store.ConnectorDescriptor
	var refused []store.ConnectorExtensionError
	seen := map[string]bool{}
	for _, descriptor := range reported {
		if len(kept) == maxExtensionConnectors {
			break
		}
		if descriptor.Extension == nil || !extensionIDPattern.MatchString(descriptor.Extension.ID) ||
			(descriptor.Holding != store.ConnectorDeviceHeld && descriptor.Holding != store.ConnectorServerHeld) ||
			descriptor.Adapter != "extension:"+descriptor.Extension.ID {
			refused = append(refused, connectorExtensionError(descriptor, "the extension id, adapter or holding is invalid"))
			continue
		}
		if err := checkText("extension name", descriptor.Extension.Name, maxLabel, true); err != nil {
			refused = append(refused, connectorExtensionError(descriptor, err.Error()))
			continue
		}
		if err := checkText("extension version", descriptor.Extension.Version, 64, true); err != nil {
			refused = append(refused, connectorExtensionError(descriptor, err.Error()))
			continue
		}
		if err := checkExtensionSource(*descriptor.Extension); err != nil {
			refused = append(refused, connectorExtensionError(descriptor, err.Error()))
			continue
		}
		if descriptor.Extension.State != "" && descriptor.Extension.State != "installed" && descriptor.Extension.State != "available" {
			refused = append(refused, connectorExtensionError(descriptor, "the extension state is invalid"))
			continue
		}
		if descriptor.Extension.State == "available" && (descriptor.Extension.Bundled == nil || !*descriptor.Extension.Bundled) {
			refused = append(refused, connectorExtensionError(descriptor, "an available extension must be bundled"))
			continue
		}
		if _, builtin := c.byKind[descriptor.Kind]; builtin || seen[descriptor.Kind] {
			refused = append(refused, connectorExtensionError(descriptor, "the connector kind is built in or appears twice"))
			continue
		}
		descriptor.AccessCheck = nil
		descriptor.RequirementsCheck = nil
		if err := checkDescriptor(descriptor); err != nil {
			refused = append(refused, connectorExtensionError(descriptor, err.Error()))
			continue
		}
		if descriptor.Package != nil {
			if err := c.checkConnectorPackage(*descriptor.Package, reported); err != nil {
				refused = append(refused, connectorExtensionError(descriptor, err.Error()))
				continue
			}
		}
		seen[descriptor.Kind] = true
		kept = append(kept, descriptor)
	}
	var valid []store.ConnectorDescriptor
	for _, descriptor := range kept {
		if descriptor.Access != nil {
			provider, ok := c.repositoryProvider(descriptor.Access.Via, kept)
			if !ok || provider.Kind == descriptor.Kind {
				refused = append(refused, connectorExtensionError(descriptor, "access.via does not name a device-held connector that declares repositoryAccess"))
				continue
			}
		}
		valid = append(valid, descriptor)
	}
	return valid, refused
}

func connectorExtensionError(descriptor store.ConnectorDescriptor, reason string) store.ConnectorExtensionError {
	extensionID, extensionName := "", ""
	if descriptor.Extension != nil {
		extensionID = shortText(descriptor.Extension.ID, 32)
		extensionName = shortText(descriptor.Extension.Name, 80)
	}
	return store.ConnectorExtensionError{
		ExtensionID: extensionID, ExtensionName: extensionName,
		Kind: shortText(descriptor.Kind, 32), Reason: shortText(reason, 300),
	}
}

// repositoryProvider finds the device-held connector that can perform a
// source-access check on this device: a built-in one or a connector this
// device's extensions provide.
func (c *Catalog) repositoryProvider(kind string, reported []store.ConnectorDescriptor) (store.ConnectorDescriptor, bool) {
	if descriptor, ok := c.byKind[kind]; ok {
		return descriptor, descriptor.Holding == store.ConnectorDeviceHeld && descriptor.RepositoryAccess != nil
	}
	for _, descriptor := range reported {
		if descriptor.Kind == kind {
			return descriptor, descriptor.Holding == store.ConnectorDeviceHeld && descriptor.RepositoryAccess != nil
		}
	}
	return store.ConnectorDescriptor{}, false
}

// extensionInstalled treats descriptors from older Workers (no state) as
// installed. A bundled descriptor marked available is only catalog data.
func extensionInstalled(descriptor store.ConnectorDescriptor) bool {
	return descriptor.Extension == nil || descriptor.Extension.State != "available"
}

// connectorsOn are the device-held connectors on each device named: the
// built-in ones and what its extensions provide.
func (d *DeviceHeld) connectorsOn(ctx context.Context, deviceIDs []string) (map[string][]store.ConnectorDescriptor, error) {
	builtin := d.catalog.DeviceHeld()
	result := map[string][]store.ConnectorDescriptor{}
	extensions, err := d.store.DeviceExtensionConnectors(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	for _, deviceID := range deviceIDs {
		for _, descriptor := range d.catalog.ExtensionConnectors(extensions[deviceID]) {
			if descriptor.Holding == store.ConnectorDeviceHeld && extensionInstalled(descriptor) {
				result[deviceID] = append(result[deviceID], descriptor)
			}
		}
		result[deviceID] = append(append([]store.ConnectorDescriptor(nil), builtin...), result[deviceID]...)
	}
	return result, nil
}

func connectorHasVisibilityGate(descriptor store.ConnectorDescriptor) bool {
	return len(descriptor.Requires) > 0 || descriptor.Access != nil
}

// ExtensionDescriptorsFor lists every well-formed extension connector on
// the devices, including server-held connectors that are not part of the
// device-held surface.
func (d *DeviceHeld) ExtensionDescriptorsFor(ctx context.Context, deviceIDs []string) (map[string][]store.ConnectorDescriptor, error) {
	reported, err := d.store.DeviceExtensionConnectors(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	result := map[string][]store.ConnectorDescriptor{}
	for _, deviceID := range deviceIDs {
		result[deviceID] = d.catalog.ExtensionConnectors(reported[deviceID])
	}
	return result, nil
}

// ServerHeldDescriptorOn finds one server-held extension descriptor on a
// device. The descriptor is the server-validated form of what that device
// reported.
func (d *DeviceHeld) ServerHeldDescriptorOn(ctx context.Context, deviceID, kind string) (store.ConnectorDescriptor, error) {
	on, err := d.ExtensionDescriptorsFor(ctx, []string{deviceID})
	if err != nil {
		return store.ConnectorDescriptor{}, err
	}
	for _, descriptor := range on[deviceID] {
		if descriptor.Kind == kind && descriptor.Holding == store.ConnectorServerHeld && descriptor.ServerHeld != nil {
			if !extensionInstalled(descriptor) {
				continue
			}
			return descriptor, nil
		}
	}
	return store.ConnectorDescriptor{}, ErrUnknownConnector
}

// ServerHeldDescriptorForOwner finds a server-held extension descriptor on
// any of the owner's devices. When multiple copies differ, the newest
// extension version wins.
func (d *DeviceHeld) ServerHeldDescriptorForOwner(ctx context.Context, ownerUserID, kind string) (store.ConnectorDescriptor, error) {
	deviceIDs, err := d.store.DevicesOwnedBy(ctx, ownerUserID)
	if err != nil {
		return store.ConnectorDescriptor{}, err
	}
	on, err := d.ExtensionDescriptorsFor(ctx, deviceIDs)
	if err != nil {
		return store.ConnectorDescriptor{}, err
	}
	var chosen store.ConnectorDescriptor
	for _, deviceID := range deviceIDs {
		for _, descriptor := range on[deviceID] {
			if descriptor.Kind != kind || descriptor.Holding != store.ConnectorServerHeld || descriptor.ServerHeld == nil {
				continue
			}
			if !extensionInstalled(descriptor) {
				continue
			}
			if chosen.Kind == "" || descriptor.Extension != nil && chosen.Extension != nil && newerVersion(descriptor.Extension.Version, chosen.Extension.Version) {
				chosen = descriptor
			}
		}
	}
	if chosen.Kind == "" {
		return store.ConnectorDescriptor{}, ErrUnknownConnector
	}
	return chosen, nil
}

// ExtensionsOn are the extensions each device reported, once each: its
// version, where it came from and the commits it reported.
func (d *DeviceHeld) ExtensionsOn(ctx context.Context, deviceIDs []string) (map[string][]store.ConnectorExtensionSource, error) {
	on, err := d.ExtensionDescriptorsFor(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	result := map[string][]store.ConnectorExtensionSource{}
	for _, deviceID := range deviceIDs {
		seen := map[string]bool{}
		for _, descriptor := range on[deviceID] {
			if descriptor.Extension == nil || seen[descriptor.Extension.ID] {
				continue
			}
			seen[descriptor.Extension.ID] = true
			result[deviceID] = append(result[deviceID], *descriptor.Extension)
		}
	}
	return result, nil
}

// ConnectorOn finds a device-held connector on the device by kind.
func (d *DeviceHeld) ConnectorOn(ctx context.Context, deviceID, kind string) (store.ConnectorDescriptor, error) {
	if descriptor, err := d.Connector(kind); err == nil {
		return descriptor, nil
	}
	on, err := d.connectorsOn(ctx, []string{deviceID})
	if err != nil {
		return store.ConnectorDescriptor{}, err
	}
	for _, descriptor := range on[deviceID] {
		if descriptor.Kind == kind {
			return descriptor, nil
		}
	}
	return store.ConnectorDescriptor{}, ErrUnknownConnector
}

// ConnectorsFor lists the device-held connectors on any of the devices: the
// built-in ones, then each extension kind once (the newest version a
// device reports), by kind. extensionKinds says which kinds each device's
// extensions provide.
func (d *DeviceHeld) ConnectorsFor(ctx context.Context, deviceIDs []string) ([]store.ConnectorDescriptor, map[string][]string, error) {
	on, err := d.ExtensionDescriptorsFor(ctx, deviceIDs)
	if err != nil {
		return nil, nil, err
	}
	listed := d.catalog.DeviceHeld()
	extensionKinds := map[string][]string{}
	byKind := map[string]store.ConnectorDescriptor{}
	available := map[string]store.ConnectorDescriptor{}
	for _, deviceID := range deviceIDs {
		for _, descriptor := range on[deviceID] {
			if descriptor.Extension == nil || descriptor.Holding != store.ConnectorDeviceHeld {
				continue
			}
			if extensionInstalled(descriptor) {
				extensionKinds[deviceID] = append(extensionKinds[deviceID], descriptor.Kind)
				if current, ok := byKind[descriptor.Kind]; !ok || newerVersion(descriptor.Extension.Version, current.Extension.Version) {
					byKind[descriptor.Kind] = descriptor
				}
			} else if _, installed := byKind[descriptor.Kind]; !installed {
				if current, ok := available[descriptor.Kind]; !ok || newerVersion(descriptor.Extension.Version, current.Extension.Version) {
					available[descriptor.Kind] = descriptor
				}
			}
		}
	}
	for kind, descriptor := range available {
		if _, installed := byKind[kind]; !installed {
			byKind[kind] = descriptor
		}
	}
	kinds := make([]string, 0, len(byKind))
	for kind := range byKind {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		listed = append(listed, byKind[kind])
	}
	return listed, extensionKinds, nil
}

// newerVersion compares dotted versions numerically where it can.
func newerVersion(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < len(pa) && i < len(pb); i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return len(pa) > len(pb)
}

func versionParts(version string) []int {
	var parts []int
	current, digits := 0, false
	for _, r := range version {
		switch {
		case r >= '0' && r <= '9':
			current = current*10 + int(r-'0')
			digits = true
		case r == '.':
			parts = append(parts, current)
			current, digits = 0, false
		default:
			if digits {
				parts = append(parts, current)
			}
			return parts
		}
	}
	if digits {
		parts = append(parts, current)
	}
	return parts
}

// ConnectorsOnDevice lists the device-held connectors on one device.
func (d *DeviceHeld) ConnectorsOnDevice(ctx context.Context, deviceID string) ([]store.ConnectorDescriptor, error) {
	on, err := d.connectorsOn(ctx, []string{deviceID})
	if err != nil {
		return nil, err
	}
	return on[deviceID], nil
}

// Catalog lists every connector a person with these devices can use and
// the gated ones that no device can currently access.
func (m *Module) CatalogFor(ctx context.Context, deviceIDs []string) ([]store.ConnectorDescriptor, []store.ConnectorRestricted, error) {
	extensions, err := m.Devices.ExtensionDescriptorsFor(ctx, deviceIDs)
	if err != nil {
		return nil, nil, err
	}
	candidates := map[string][]store.ConnectorDescriptor{}
	for _, descriptor := range m.catalog.All() {
		candidates[descriptor.Kind] = append(candidates[descriptor.Kind], descriptor)
	}
	for _, deviceID := range deviceIDs {
		for _, descriptor := range extensions[deviceID] {
			candidates[descriptor.Kind] = append(candidates[descriptor.Kind], descriptor)
		}
	}
	chosen := map[string]store.ConnectorDescriptor{}
	for kind, copies := range candidates {
		chosen[kind] = chooseDescriptor(copies)
	}
	checks, err := m.Devices.store.ListConnectorVisibilityChecks(ctx, deviceIDs)
	if err != nil {
		return nil, nil, err
	}
	checkByKey := map[string]store.ConnectorVisibilityCheck{}
	for _, check := range checks {
		checkByKey[visibilityKey(check.DeviceID, check.Result, check.Kind, check.Via, check.Repository)] = check
	}
	visible := map[string]bool{}
	restricted := map[string]bool{}
	devicesByKind := map[string][]string{}
	for _, deviceID := range deviceIDs {
		for _, descriptor := range extensions[deviceID] {
			devicesByKind[descriptor.Kind] = append(devicesByKind[descriptor.Kind], deviceID)
		}
	}
	for kind, descriptor := range chosen {
		if !connectorHasVisibilityGate(descriptor) {
			visible[kind] = true
			continue
		}
		devices := devicesByKind[kind]
		if descriptor.Extension == nil {
			devices = append([]string(nil), deviceIDs...)
		}
		for _, deviceID := range devices {
			requirementsOK := len(descriptor.Requires) == 0
			if len(descriptor.Requires) > 0 {
				check, ok := checkByKey[visibilityKey(deviceID, store.ConnectorVisibilityRequirements, kind, requirementVisibilitySignature(descriptor), "")]
				requirementsOK = ok && check.Status == "ok"
			}
			accessOK := descriptor.Access == nil
			if descriptor.Access != nil {
				check, ok := checkByKey[visibilityKey(deviceID, store.ConnectorVisibilityRepository, kind, descriptor.Access.Via, descriptor.Access.Repository)]
				accessOK = ok && check.Status == "ok"
			}
			if requirementsOK && accessOK {
				visible[kind] = true
				break
			}
		}
		if !visible[kind] {
			restricted[kind] = true
		}
	}
	listed := []store.ConnectorDescriptor{}
	for _, descriptor := range m.catalog.All() {
		if current, ok := chosen[descriptor.Kind]; ok && current.Kind == descriptor.Kind && visible[descriptor.Kind] {
			if descriptor.Holding == store.ConnectorServerHeld {
				listed = append(listed, current)
			}
		}
	}
	kinds := make([]string, 0, len(chosen))
	for kind, descriptor := range chosen {
		if descriptor.Extension != nil && descriptor.Holding == store.ConnectorServerHeld && visible[kind] {
			kinds = append(kinds, kind)
		}
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		listed = append(listed, chosen[kind])
	}
	for _, descriptor := range m.catalog.DeviceHeld() {
		if visible[descriptor.Kind] {
			listed = append(listed, descriptor)
		}
	}
	kinds = kinds[:0]
	for kind, descriptor := range chosen {
		if descriptor.Extension != nil && descriptor.Holding == store.ConnectorDeviceHeld && visible[kind] {
			kinds = append(kinds, kind)
		}
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		listed = append(listed, chosen[kind])
	}
	var hidden []store.ConnectorRestricted
	for kind := range restricted {
		descriptor := chosen[kind]
		item := store.ConnectorRestricted{Connector: descriptor}
		devices := devicesByKind[kind]
		if descriptor.Extension == nil {
			devices = append([]string(nil), deviceIDs...)
		}
		for _, deviceID := range devices {
			var requirementsCheck *store.ConnectorRequirementsCheck
			if len(descriptor.Requires) > 0 {
				if check, ok := checkByKey[visibilityKey(deviceID, store.ConnectorVisibilityRequirements, kind, requirementVisibilitySignature(descriptor), "")]; ok {
					requirementsCheck = &store.ConnectorRequirementsCheck{
						OK: check.Status == "ok", CheckedAt: check.CheckedAt, Requirement: check.Requirement,
					}
				}
			}
			var accessCheck *store.ConnectorRestrictedAccessCheck
			if descriptor.Access != nil {
				if check, ok := checkByKey[visibilityKey(deviceID, store.ConnectorVisibilityRepository, kind, descriptor.Access.Via, descriptor.Access.Repository)]; ok {
					accessCheck = &store.ConnectorRestrictedAccessCheck{
						ConnectorSourceAccessCheck: store.ConnectorSourceAccessCheck{
							Status: check.Status, CheckedAt: check.CheckedAt, Identity: check.Identity, Detail: check.Detail,
						},
						Via: descriptor.Access.Via,
					}
				}
			}
			item.Devices = append(item.Devices, store.ConnectorRestrictedDevice{
				DeviceID: deviceID, RequirementsCheck: requirementsCheck, AccessCheck: accessCheck,
			})
		}
		hidden = append(hidden, item)
	}
	sort.Slice(hidden, func(i, j int) bool { return hidden[i].Connector.Kind < hidden[j].Connector.Kind })
	return listed, hidden, nil
}

func chooseDescriptor(copies []store.ConnectorDescriptor) store.ConnectorDescriptor {
	chosen := copies[0]
	for _, candidate := range copies[1:] {
		if chosen.Extension == nil && candidate.Extension != nil {
			continue
		}
		if chosen.Extension != nil && candidate.Extension == nil {
			chosen = candidate
			continue
		}
		if chosen.Extension == nil && candidate.Extension == nil {
			continue
		}
		chosenInstalled := extensionInstalled(chosen)
		candidateInstalled := extensionInstalled(candidate)
		if candidateInstalled != chosenInstalled {
			if candidateInstalled {
				chosen = candidate
			}
			continue
		}
		if newerVersion(candidate.Extension.Version, chosen.Extension.Version) {
			chosen = candidate
		}
	}
	return chosen
}

func visibilityKey(deviceID, result, kind, via, repository string) string {
	return strings.Join([]string{deviceID, result, kind, via, repository}, "\x00")
}

func requirementVisibilitySignature(descriptor store.ConnectorDescriptor) string {
	var parts []string
	for _, requirement := range descriptor.Requires {
		parts = append(parts, requirement.Kind+"|"+requirement.Host+"|"+strconv.Itoa(requirement.Port)+"|"+requirement.Label)
	}
	if descriptor.Extension != nil {
		parts = append(parts, descriptor.Extension.Version, descriptor.Extension.Commit)
	}
	return strings.Join(parts, "\n")
}

// VisibilityTarget is one cached check the server should ask a device to
// refresh. For repository access Connector is the provider connector.
type VisibilityTarget struct {
	DeviceID   string
	Result     string
	Kind       string
	Connector  store.ConnectorDescriptor
	Via        string
	Repository string
}

// VisibilityTargets lists the scheduled checks for gated connectors on each
// device. A check runs on the same device that may satisfy both conditions.
func (m *Module) VisibilityTargets(ctx context.Context, deviceIDs []string) ([]VisibilityTarget, error) {
	extensions, err := m.Devices.ExtensionDescriptorsFor(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	var targets []VisibilityTarget
	seen := map[string]bool{}
	for _, deviceID := range deviceIDs {
		onDevice := map[string]store.ConnectorDescriptor{}
		for kind, descriptor := range m.catalog.byKind {
			onDevice[kind] = descriptor
		}
		for _, descriptor := range extensions[deviceID] {
			onDevice[descriptor.Kind] = descriptor
		}
		for _, descriptor := range onDevice {
			if len(descriptor.Requires) > 0 {
				key := visibilityKey(deviceID, store.ConnectorVisibilityRequirements, descriptor.Kind, requirementVisibilitySignature(descriptor), "")
				if !seen[key] {
					seen[key] = true
					targets = append(targets, VisibilityTarget{
						DeviceID: deviceID, Result: store.ConnectorVisibilityRequirements,
						Kind: descriptor.Kind, Connector: descriptor, Via: requirementVisibilitySignature(descriptor),
					})
				}
			}
			if descriptor.Access == nil {
				continue
			}
			provider, ok := m.catalog.repositoryProvider(descriptor.Access.Via, extensions[deviceID])
			if !ok || provider.Kind == descriptor.Kind {
				continue
			}
			key := visibilityKey(deviceID, store.ConnectorVisibilityRepository, descriptor.Kind, descriptor.Access.Via, descriptor.Access.Repository)
			if seen[key] {
				continue
			}
			seen[key] = true
			targets = append(targets, VisibilityTarget{
				DeviceID: deviceID, Result: store.ConnectorVisibilityRepository,
				Kind: descriptor.Kind, Connector: provider,
				Via: descriptor.Access.Via, Repository: descriptor.Access.Repository,
			})
		}
	}
	return targets, nil
}

// VisibleKinds applies both visibility gates to the connectors known on the
// devices named. At least one device must meet every requirement and, when
// declared, read the source repository through the named connector.
func (d *DeviceHeld) VisibleKinds(ctx context.Context, deviceIDs []string) (map[string]bool, error) {
	extensions, err := d.ExtensionDescriptorsFor(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	checks, err := d.store.ListConnectorVisibilityChecks(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	checkByKey := map[string]store.ConnectorVisibilityCheck{}
	for _, check := range checks {
		checkByKey[visibilityKey(check.DeviceID, check.Result, check.Kind, check.Via, check.Repository)] = check
	}
	byKind := map[string]store.ConnectorDescriptor{}
	devicesByKind := map[string][]string{}
	for _, descriptor := range d.catalog.All() {
		byKind[descriptor.Kind] = descriptor
	}
	for _, deviceID := range deviceIDs {
		for _, descriptor := range extensions[deviceID] {
			current, ok := byKind[descriptor.Kind]
			if !ok || descriptor.Extension != nil && (current.Extension == nil || newerVersion(descriptor.Extension.Version, current.Extension.Version)) {
				byKind[descriptor.Kind] = descriptor
			}
			devicesByKind[descriptor.Kind] = append(devicesByKind[descriptor.Kind], deviceID)
		}
	}
	visible := map[string]bool{}
	for kind, descriptor := range byKind {
		if !connectorHasVisibilityGate(descriptor) {
			visible[kind] = true
			continue
		}
		devices := devicesByKind[kind]
		if descriptor.Extension == nil {
			devices = deviceIDs
		}
		for _, deviceID := range devices {
			requirementsOK := len(descriptor.Requires) == 0
			if len(descriptor.Requires) > 0 {
				check, ok := checkByKey[visibilityKey(deviceID, store.ConnectorVisibilityRequirements, kind, requirementVisibilitySignature(descriptor), "")]
				requirementsOK = ok && check.Status == "ok"
			}
			accessOK := descriptor.Access == nil
			if descriptor.Access != nil {
				check, ok := checkByKey[visibilityKey(deviceID, store.ConnectorVisibilityRepository, kind, descriptor.Access.Via, descriptor.Access.Repository)]
				accessOK = ok && check.Status == "ok"
			}
			if requirementsOK && accessOK {
				visible[kind] = true
				break
			}
		}
	}
	return visible, nil
}

// VisibleKinds is the module-level face of DeviceHeld.VisibleKinds.
func (m *Module) VisibleKinds(ctx context.Context, deviceIDs []string) (map[string]bool, error) {
	return m.Devices.VisibleKinds(ctx, deviceIDs)
}

// SanitizeDeviceConnectors keeps what a registering device may report of
// its extensions' connectors (Catalog.ExtensionConnectors).
func (m *Module) SanitizeDeviceConnectors(reported []store.ConnectorDescriptor) ([]store.ConnectorDescriptor, []store.ConnectorExtensionError) {
	return m.catalog.ExtensionConnectorsWithErrors(reported)
}
