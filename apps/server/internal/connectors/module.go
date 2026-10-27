package connectors

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what the module keeps: server-held accounts and apps, and what
// devices read of their device-held connectors. Credentials of the first
// kind live in the secret store; of the second, only on the device.
type Store interface {
	store.ExternalAccountStore
	store.DeviceConnectorStore
}

// Module is the Connectors module: the catalog, the server-held kind
// (externalaccounts.Service: logins, refresh, the materials the Feishu
// gateway serves) and the device-held kind (DeviceHeld).
type Module struct {
	Cloudflare *CloudflareGateway
	catalog    *Catalog
	// ServerHeld runs the server-held connectors' accounts and apps. Only
	// the connector HTTP files and the Feishu gateway and channel use it.
	ServerHeld *externalaccounts.Service
	// Devices keeps what devices read of their device-held connectors and
	// which workspaces may use them.
	Devices *DeviceHeld
}

// New builds the module over the store and the sealed secret store (nil
// when the server has none: server-held connectors then connect nothing).
func New(st Store, secrets externalaccounts.SecretKeeper, sw *integrations.Switch) *Module {
	serverHeld := externalaccounts.NewService(st, secrets, nil)
	serverHeld.Integrations = sw
	catalog := DefaultCatalog()
	m := &Module{catalog: catalog, ServerHeld: serverHeld, Devices: NewDeviceHeld(st, catalog)}
	if gatewayStore, ok := st.(CloudflareStore); ok {
		m.Cloudflare = NewCloudflareGateway(gatewayStore, serverHeld)
	}
	return m
}

// Catalog lists every connector.
func (m *Module) Catalog() []store.ConnectorDescriptor { return m.catalog.All() }

// Lookup finds a connector by kind.
func (m *Module) Lookup(kind string) (store.ConnectorDescriptor, bool) { return m.catalog.Lookup(kind) }

// SessionRequest is a session about to run on a device.
type SessionRequest struct {
	Session store.AgentSession
	// DeviceOwner is the account behind the device's credential.
	DeviceOwner string
	// HasCapability says what the device's worker declared.
	HasCapability func(string) bool
}

// SessionConnectors is everything run_session carries for connectors.
type SessionConnectors struct {
	// ExternalAccounts are the server-held accounts the session may act as,
	// as gateway stand-ins.
	ExternalAccounts []store.ExternalAccountMaterial
	// DeviceConnectors are the device-held connectors on the session's
	// device and what the session may do with each.
	DeviceConnectors []store.DeviceConnectorUse
	// GatewayMissing: server-held accounts would apply, but the worker has
	// no gateway forwarder; the session's transcript should say so.
	GatewayMissing bool
}

// sandboxedRole: an Issue's execution or clarification runs with a private
// HOME, where neither kind of connector is set up.
func sandboxedRole(role string) bool {
	return role == store.AgentSessionRoleIssueExecution || role == store.AgentSessionRoleIssueClarification
}

// SessionConnectors decides, for both kinds, what a session gets. It is
// the one call session dispatch makes into the module.
func (m *Module) SessionConnectors(ctx context.Context, request SessionRequest) SessionConnectors {
	var result SessionConnectors
	session := request.Session
	if sandboxedRole(session.Role) || session.Source == "verification" {
		return result
	}
	has := request.HasCapability
	if has == nil {
		has = func(string) bool { return false }
	}
	if has(store.DaemonCapabilityFeishuGateway) {
		materials, err := m.ServerHeld.SessionMaterials(ctx, session.WorkspaceID, session.ID, session.DeviceID, session.CreatedByUserID, request.DeviceOwner)
		if err != nil {
			m.ServerHeld.Logf("external accounts for session %s: %v", session.ID, err)
		}
		for _, material := range materials {
			if material.Provider == "cloudflare" && !has("cloudflare_gateway_v1") {
				continue
			}
			result.ExternalAccounts = append(result.ExternalAccounts, material)
		}
	} else {
		accounts, err := m.ServerHeld.SessionAccounts(ctx, session.WorkspaceID, session.CreatedByUserID, request.DeviceOwner)
		result.GatewayMissing = err == nil && len(accounts) > 0
	}
	if has(store.DaemonCapabilityDeviceConnectors) {
		uses, err := m.Devices.SessionUses(ctx, session, request.DeviceOwner)
		if err != nil {
			m.ServerHeld.Logf("device connectors for session %s: %v", session.ID, err)
		}
		result.DeviceConnectors = uses
	}
	return result
}
