package connectors

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what the module keeps: server-held accounts and apps with the
// Cloudflare gateway's session handles (CloudflareStore), and what devices
// read of their device-held connectors. Credentials of the first kind live
// in the secret store; of the second, only on the device.
type Store interface {
	CloudflareStore
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
	return &Module{catalog: catalog, ServerHeld: serverHeld, Devices: NewDeviceHeld(st, catalog), Cloudflare: NewCloudflareGateway(st, serverHeld)}
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
	// HasCapability says what the device's worker declared; a worker whose
	// execution host predates cloudflare_gateway_v1 gets no Cloudflare
	// account.
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
	materials, err := m.ServerHeld.SessionMaterials(ctx, session.WorkspaceID, session.ID, session.DeviceID, session.CreatedByUserID, request.DeviceOwner)
	if err != nil {
		m.ServerHeld.Logf("external accounts for session %s: %v", session.ID, err)
	}
	for _, material := range materials {
		if material.Provider == "cloudflare" && !request.HasCapability("cloudflare_gateway_v1") {
			continue
		}
		result.ExternalAccounts = append(result.ExternalAccounts, material)
	}
	uses, err := m.Devices.SessionUses(ctx, session, request.DeviceOwner)
	if err != nil {
		m.ServerHeld.Logf("device connectors for session %s: %v", session.ID, err)
	}
	result.DeviceConnectors = uses
	return result
}
