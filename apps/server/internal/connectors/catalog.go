// Package connectors is the Connectors module's face to the rest of the
// server (docs/connectors.md, "模块边界"). Every connector is a line of data
// in catalog.json; platform quirks live in small adapters named by the
// descriptor's adapter: a server-held connector's in internal/externalaccounts
// (Feishu: device flow, refresh, the gateway in internal/feishugateway), a
// device-held connector's in the worker (packages/worker/src/connectors).
// Outside this package, internal/externalaccounts, internal/feishugateway and
// internal/feishuevents are used only by the connector HTTP files and the
// Feishu channel (scripts/audit-module-boundaries.mjs).
package connectors

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

//go:embed catalog.json
var catalogJSON []byte

// Catalog is every connector this server knows, by kind.
type Catalog struct {
	descriptors []store.ConnectorDescriptor
	byKind      map[string]store.ConnectorDescriptor
}

var (
	kindPattern    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	commandPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$`)
	envNamePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	envValuePatten = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	hostPattern    = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)
)

// ParseCatalog reads and checks a catalog: kinds unique and well formed, a
// known holding, a tool command, a device-held connector installed locally or from
// npm, requirements a worker can check, isolation a plain variable.
func ParseCatalog(data []byte) (*Catalog, error) {
	var descriptors []store.ConnectorDescriptor
	if err := json.Unmarshal(data, &descriptors); err != nil {
		return nil, fmt.Errorf("connector catalog: %w", err)
	}
	catalog := &Catalog{byKind: map[string]store.ConnectorDescriptor{}}
	for _, descriptor := range descriptors {
		if err := checkDescriptor(descriptor); err != nil {
			return nil, fmt.Errorf("connector catalog: %s: %w", descriptor.Kind, err)
		}
		if _, dup := catalog.byKind[descriptor.Kind]; dup {
			return nil, fmt.Errorf("connector catalog: %s is listed twice", descriptor.Kind)
		}
		catalog.byKind[descriptor.Kind] = descriptor
		catalog.descriptors = append(catalog.descriptors, descriptor)
	}
	sort.SliceStable(catalog.descriptors, func(i, j int) bool { return catalog.descriptors[i].Kind < catalog.descriptors[j].Kind })
	return catalog, nil
}

func checkDescriptor(descriptor store.ConnectorDescriptor) error {
	if !kindPattern.MatchString(descriptor.Kind) {
		return fmt.Errorf("kind must match %s", kindPattern)
	}
	if descriptor.Label == "" || descriptor.Adapter == "" {
		return fmt.Errorf("needs a label and an adapter")
	}
	if !commandPattern.MatchString(descriptor.Tool.Command) {
		return fmt.Errorf("needs a tool command")
	}
	switch descriptor.Holding {
	case store.ConnectorServerHeld:
		if len(descriptor.Requires) > 0 || len(descriptor.IsolationEnv) > 0 {
			return fmt.Errorf("a server-held connector declares no device requirement or isolation")
		}
	case store.ConnectorDeviceHeld:
		switch descriptor.Tool.Source {
		case "npm":
			if descriptor.Tool.Package == "" || descriptor.Tool.Registry == "" {
				return fmt.Errorf("an npm connector names its package and registry")
			}
		case "device":
			if descriptor.Tool.Package != "" || descriptor.Tool.Registry != "" {
				return fmt.Errorf("a device-installed tool declares no npm package or registry")
			}
		default:
			return fmt.Errorf("a device-held connector installs from npm or the device")
		}
	default:
		return fmt.Errorf("holding must be %s or %s", store.ConnectorServerHeld, store.ConnectorDeviceHeld)
	}
	if descriptor.Authentication != "" && (descriptor.Authentication != "local" || descriptor.Holding != store.ConnectorDeviceHeld) {
		return fmt.Errorf("local authentication is only supported for device-held connectors")
	}
	for _, requirement := range descriptor.Requires {
		if requirement.Kind != "tcp_reachable" || requirement.Label == "" || requirement.Port <= 0 || requirement.Port > 65535 {
			return fmt.Errorf("a requirement is tcp_reachable with a label and a port")
		}
		if !hostPattern.MatchString(requirement.Host) {
			return fmt.Errorf("a requirement names a host")
		}
	}
	for name, value := range descriptor.IsolationEnv {
		if !envNamePattern.MatchString(name) || !envValuePatten.MatchString(value) {
			return fmt.Errorf("isolation variable %s is not a plain name and value", name)
		}
	}
	return nil
}

// DefaultCatalog is the embedded catalog.json.
func DefaultCatalog() *Catalog {
	catalog, err := ParseCatalog(catalogJSON)
	if err != nil {
		panic(err)
	}
	return catalog
}

// All lists every connector, by kind.
func (c *Catalog) All() []store.ConnectorDescriptor {
	return append([]store.ConnectorDescriptor(nil), c.descriptors...)
}

// Lookup finds a connector by kind.
func (c *Catalog) Lookup(kind string) (store.ConnectorDescriptor, bool) {
	descriptor, ok := c.byKind[kind]
	return descriptor, ok
}

// DeviceHeld lists the device-held connectors.
func (c *Catalog) DeviceHeld() []store.ConnectorDescriptor {
	var held []store.ConnectorDescriptor
	for _, descriptor := range c.descriptors {
		if descriptor.Holding == store.ConnectorDeviceHeld {
			held = append(held, descriptor)
		}
	}
	return held
}
