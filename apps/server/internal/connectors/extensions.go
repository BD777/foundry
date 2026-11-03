package connectors

import (
	"context"
	"regexp"
	"sort"

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
// reported for its extensions: device-held, adapter "extension:<id>" with
// the extension named, a kind no built-in connector has, each kind once.
func (c *Catalog) ExtensionConnectors(reported []store.ConnectorDescriptor) []store.ConnectorDescriptor {
	var kept []store.ConnectorDescriptor
	seen := map[string]bool{}
	for _, descriptor := range reported {
		if len(kept) == maxExtensionConnectors {
			break
		}
		if descriptor.Extension == nil || !extensionIDPattern.MatchString(descriptor.Extension.ID) ||
			descriptor.Holding != store.ConnectorDeviceHeld || descriptor.Adapter != "extension:"+descriptor.Extension.ID {
			continue
		}
		if checkText("extension name", descriptor.Extension.Name, maxLabel, true) != nil || checkText("extension version", descriptor.Extension.Version, 64, true) != nil {
			continue
		}
		if _, builtin := c.byKind[descriptor.Kind]; builtin || seen[descriptor.Kind] {
			continue
		}
		if checkDescriptor(descriptor) != nil {
			continue
		}
		seen[descriptor.Kind] = true
		kept = append(kept, descriptor)
	}
	return kept
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
		result[deviceID] = append(append([]store.ConnectorDescriptor(nil), builtin...), d.catalog.ExtensionConnectors(extensions[deviceID])...)
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
	on, err := d.connectorsOn(ctx, deviceIDs)
	if err != nil {
		return nil, nil, err
	}
	listed := d.catalog.DeviceHeld()
	extensionKinds := map[string][]string{}
	byKind := map[string]store.ConnectorDescriptor{}
	for _, deviceID := range deviceIDs {
		for _, descriptor := range on[deviceID] {
			if descriptor.Extension == nil {
				continue
			}
			extensionKinds[deviceID] = append(extensionKinds[deviceID], descriptor.Kind)
			if current, ok := byKind[descriptor.Kind]; !ok || newerVersion(descriptor.Extension.Version, current.Extension.Version) {
				byKind[descriptor.Kind] = descriptor
			}
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

// Catalog lists every connector a person with these devices can use: all
// built-in ones (server- and device-held) and the extension ones on them.
func (m *Module) CatalogFor(ctx context.Context, deviceIDs []string) ([]store.ConnectorDescriptor, error) {
	deviceHeld, _, err := m.Devices.ConnectorsFor(ctx, deviceIDs)
	if err != nil {
		return nil, err
	}
	listed := []store.ConnectorDescriptor{}
	for _, descriptor := range m.catalog.All() {
		if descriptor.Holding == store.ConnectorServerHeld {
			listed = append(listed, descriptor)
		}
	}
	return append(listed, deviceHeld...), nil
}

// SanitizeDeviceConnectors keeps what a registering device may report of
// its extensions' connectors (Catalog.ExtensionConnectors).
func (m *Module) SanitizeDeviceConnectors(reported []store.ConnectorDescriptor) []store.ConnectorDescriptor {
	return m.catalog.ExtensionConnectors(reported)
}
