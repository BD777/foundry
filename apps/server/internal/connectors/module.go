package connectors

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what the module keeps: server-held accounts and apps with the
// Cloudflare gateway's session handles (CloudflareStore), and what devices
// read of their device-held connectors. Credentials of the first kind live
// in the secret store; of the second, only on the device.
type Store interface {
	CloudflareStore
	store.AppStoreConnectStore
	store.DeviceConnectorStore
	externalaccounts.ConnectorAccessStore
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
	// AppStoreConnect is the server-held App Store Connect gateway.
	AppStoreConnect *AppStoreConnectGateway
	// Devices keeps what devices read of their device-held connectors and
	// which workspaces may use them.
	Devices *DeviceHeld
	// ToolChecks are the tool version checks in progress, whose gateway
	// grants act for no session (ToolCheck).
	ToolChecks *gateway.Checks
}

// New builds the module over the store and the sealed secret store (nil
// when the server has none: server-held connectors then connect nothing).
func New(st Store, secrets externalaccounts.SecretKeeper, sw *integrations.Switch) *Module {
	serverHeld := externalaccounts.NewService(st, secrets, nil)
	serverHeld.Integrations = sw
	catalog := DefaultCatalog()
	return &Module{
		catalog: catalog, ServerHeld: serverHeld, Devices: NewDeviceHeld(st, catalog),
		Cloudflare: NewCloudflareGateway(st, serverHeld), AppStoreConnect: NewAppStoreConnectGateway(st, serverHeld),
		ToolChecks: gateway.NewChecks(),
	}
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

// takesConnectors is the one rule for which sessions may act through
// connectors of either kind: those that run as the person's own agent in
// their HOME (chats, sessions agents start, the Personal Agent). Every
// session of an Issue runs in its candidate's sandbox with a private HOME,
// a verifier only checks, and Foundry's diagnostic, naming, digest and
// maintenance sessions only read. SessionConnectors decides it at dispatch
// and sends other sessions nothing; the worker sets up exactly what
// run_session carries, and the Cloudflare gateway asks it again on every
// call.
func takesConnectors(session store.AgentSession) bool {
	if session.IssueID != "" || session.Role == store.AgentSessionRoleIssueExecution || session.Role == store.AgentSessionRoleIssueClarification {
		return false
	}
	return session.Source != store.SessionSourceVerification && !store.IsUtilitySessionSource(session.Source)
}

// SessionConnectors decides, for both kinds, what a session gets. It is
// the one call session dispatch makes into the module.
func (m *Module) SessionConnectors(ctx context.Context, request SessionRequest) SessionConnectors {
	var result SessionConnectors
	session := request.Session
	if !takesConnectors(session) {
		return result
	}
	materials, err := m.ServerHeld.SessionMaterials(ctx, session.WorkspaceID, session.ID, session.DeviceID, session.CreatedByUserID, request.DeviceOwner)
	if err != nil {
		m.ServerHeld.Logf("external accounts for session %s: %v", session.ID, err)
	}
	for i := range materials {
		if materials[i].Provider == "cloudflare" && m.Cloudflare != nil {
			materials[i].ProviderAccountID = m.Cloudflare.ProviderAccountID(ctx, session, request.DeviceOwner, materials[i].AccountID)
		}
	}
	result.ExternalAccounts = append(result.ExternalAccounts, materials...)
	uses, err := m.Devices.SessionUses(ctx, session, request.DeviceOwner)
	if err != nil {
		m.ServerHeld.Logf("device connectors for session %s: %v", session.ID, err)
	}
	result.DeviceConnectors = uses
	return result
}
