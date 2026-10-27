package store

import "context"

// Connectors: the catalog every connector is described by, and the
// device-held kind, whose credential never leaves the device (first:
// bytedcli). The server keeps only what a device read of it: whether it is
// installed and signed in, the identity label the tool shows, the sites and
// when the login ends; and which workspaces may use which device's login.
// These mirror packages/protocol/src/connectors.ts.

// Connector holdings: who keeps a connector's credential.
const (
	ConnectorServerHeld = "server_held"
	ConnectorDeviceHeld = "device_held"
)

// DaemonCapabilityDeviceConnectors: the worker answers connector_request.
const DaemonCapabilityDeviceConnectors = "device_connectors"

// ConnectorRequirement is a condition a device must meet for the connector
// to work there ("tcp_reachable": host:port opens within a few seconds).
type ConnectorRequirement struct {
	Kind  string `json:"kind"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
	Label string `json:"label"`
}

// ConnectorTool is the program a connector's sessions use and where
// Foundry installs it from ("npm" through the managed-tools path).
type ConnectorTool struct {
	Command  string `json:"command"`
	Source   string `json:"source,omitempty"`
	Package  string `json:"package,omitempty"`
	Registry string `json:"registry,omitempty"`
}

type ConnectorAuthorizationGroup struct {
	ID           string            `json:"id"`
	Revision     int               `json:"revision"`
	Label        string            `json:"label"`
	Labels       map[string]string `json:"labels,omitempty"`
	Capabilities []string          `json:"capabilities"`
	Credential   string            `json:"credential"`
}
type ConnectorAuthorizationState struct {
	ID           string `json:"id"`
	Revision     int    `json:"revision"`
	Status       string `json:"status"`
	CheckedAt    string `json:"checkedAt"`
	Verification string `json:"verification"`
	Reason       string `json:"reason,omitempty"`
}
type ConnectorAuthorizationChallenge struct {
	Kind        string `json:"kind"`
	URL         string `json:"url,omitempty"`
	UserCode    string `json:"userCode,omitempty"`
	ImageURL    string `json:"imageUrl,omitempty"`
	Instruction string `json:"instruction,omitempty"`
}

const DaemonCapabilityConnectorAuthorization = "connector_authorization_v1"

// ConnectorDescriptor is one connector, as data (internal/connectors/catalog.json).
type ConnectorDescriptor struct {
	Authentication      string                        `json:"authentication,omitempty"`
	AuthorizationGroups []ConnectorAuthorizationGroup `json:"authorizationGroups,omitempty"`
	Kind                string                        `json:"kind"`
	Label               string                        `json:"label"`
	Holding             string                        `json:"holding"`
	Adapter             string                        `json:"adapter"`
	Tool                ConnectorTool                 `json:"tool"`
	Requires            []ConnectorRequirement        `json:"requires,omitempty"`
	ExpiryReminderDays  int                           `json:"expiryReminderDays,omitempty"`
	IsolationEnv        map[string]string             `json:"isolationEnv,omitempty"`
}

// Device-held connector statuses.
const (
	DeviceConnectorReady        = "ready"
	DeviceConnectorExpiring     = "expiring"
	DeviceConnectorExpired      = "expired"
	DeviceConnectorSignedOut    = "signed_out"
	DeviceConnectorNotInstalled = "not_installed"
	DeviceConnectorUnavailable  = "unavailable"
	DeviceConnectorError        = "error"
)

// DeviceConnectorState is a device-held connector on one device as last
// read there. It never holds a credential.
type DeviceConnectorState struct {
	Authorizations []ConnectorAuthorizationState `json:"authorizations,omitempty"`
	DeviceID       string                        `json:"deviceId"`
	Kind           string                        `json:"kind"`
	Status         string                        `json:"status"`
	StatusDetail   string                        `json:"statusDetail,omitempty"`
	Installed      bool                          `json:"installed"`
	Version        string                        `json:"version,omitempty"`
	InstallSource  string                        `json:"installSource,omitempty"`
	LatestVersion  string                        `json:"latestVersion,omitempty"`
	SignedIn       bool                          `json:"signedIn"`
	Identity       string                        `json:"identity,omitempty"`
	Sites          []string                      `json:"sites,omitempty"`
	ExpiresAt      string                        `json:"expiresAt,omitempty"`
	CheckedAt      string                        `json:"checkedAt"`
	ExpiringSince  string                        `json:"expiringSince,omitempty"`
}

// DeviceConnectorSignIn is a sign-in through the device's tool, relayed to
// the person: the page to approve on, then the outcome.
type DeviceConnectorSignIn struct {
	Phase                 string                           `json:"phase,omitempty"`
	AuthorizationID       string                           `json:"authorizationId,omitempty"`
	AuthorizationRevision int                              `json:"authorizationRevision,omitempty"`
	Challenge             *ConnectorAuthorizationChallenge `json:"challenge,omitempty"`
	Image                 []byte                           `json:"-"`
	OperationID           string                           `json:"operationId,omitempty"`
	ExpiresAt             string                           `json:"expiresAt,omitempty"`
	IntervalSeconds       int                              `json:"intervalSeconds,omitempty"`
	Status                string                           `json:"status"`
	VerificationURL       string                           `json:"verificationUrl,omitempty"`
	UserCode              string                           `json:"userCode,omitempty"`
	Error                 string                           `json:"error,omitempty"`
	State                 *DeviceConnectorState            `json:"state,omitempty"`
}

// DeviceConnectorDevice is one of the person's devices with its
// device-held connectors.
type DeviceConnectorDevice struct {
	AuthorizationSupported bool                   `json:"authorizationSupported,omitempty"`
	DeviceID               string                 `json:"deviceId"`
	Name                   string                 `json:"name"`
	Online                 bool                   `json:"online"`
	Supported              bool                   `json:"supported"`
	States                 []DeviceConnectorState `json:"states"`
}

// DeviceConnectorsView is the device-held part of the Connectors page.
type DeviceConnectorsView struct {
	Connectors []ConnectorDescriptor   `json:"connectors"`
	Devices    []DeviceConnectorDevice `json:"devices"`
}

// DeviceConnectorBinding shares a device login with a workspace's members.
// The owner's own unsandboxed sessions use ready logins without a binding.
type DeviceConnectorBinding struct {
	WorkspaceID string                `json:"workspaceId"`
	Kind        string                `json:"kind"`
	DeviceID    string                `json:"deviceId"`
	Members     bool                  `json:"members"`
	GrantedBy   string                `json:"grantedBy"`
	CreatedAt   string                `json:"createdAt"`
	DeviceName  string                `json:"deviceName,omitempty"`
	State       *DeviceConnectorState `json:"state,omitempty"`
}

// WorkspaceDeviceConnectors is a workspace's device-held bindings and the
// caller's devices to bind.
type ConnectorExecutionDevice struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
}

type WorkspaceDeviceConnectors struct {
	ExecutionDevices []ConnectorExecutionDevice `json:"executionDevices"`
	DefaultDeviceID  string                     `json:"defaultDeviceId"`
	WorkspaceID      string                     `json:"workspaceId"`
	Connectors       []ConnectorDescriptor      `json:"connectors"`
	Bindings         []DeviceConnectorBinding   `json:"bindings"`
	Devices          []DeviceConnectorDevice    `json:"devices"`
}

// DeviceConnectorBindingInput is one binding the caller wants.
type DeviceConnectorBindingInput struct {
	Kind     string `json:"kind"`
	DeviceID string `json:"deviceId"`
	Members  bool   `json:"members,omitempty"`
}

// SetWorkspaceDeviceConnectorsInput replaces the caller's own bindings.
type SetWorkspaceDeviceConnectorsInput struct {
	Bindings []DeviceConnectorBindingInput `json:"bindings"`
}

// DeviceConnectorUse rides run_session: what the session may do with a
// device-held connector on its device ("device_login" or "none").
type DeviceConnectorUse struct {
	// State is checked metadata only, including separate authorization groups.
	State        *DeviceConnectorState `json:"state,omitempty"`
	Kind         string                `json:"kind"`
	Adapter      string                `json:"adapter"`
	Label        string                `json:"label"`
	Command      string                `json:"command"`
	Access       string                `json:"access"`
	IsolationEnv map[string]string     `json:"isolationEnv,omitempty"`
}

// ConnectorRequestPayload is connector_request: one action on a
// device-held connector ("status", "install", "sign_in_begin",
// "sign_in_poll", "sign_out").
type ConnectorRequestPayload struct {
	AuthorizationID       string              `json:"authorizationId,omitempty"`
	AuthorizationRevision int                 `json:"authorizationRevision,omitempty"`
	OperationID           string              `json:"operationId,omitempty"`
	Action                string              `json:"action"`
	Connector             ConnectorDescriptor `json:"connector"`
	Fresh                 bool                `json:"fresh,omitempty"`
}

// ConnectorReplyPayload is connector_reply.
type ConnectorReplyPayload struct {
	AuthorizationImage string                 `json:"authorizationImage,omitempty"`
	State              *DeviceConnectorState  `json:"state,omitempty"`
	SignIn             *DeviceConnectorSignIn `json:"signIn,omitempty"`
	Error              string                 `json:"error,omitempty"`
}

// DeviceConnectorStore keeps what devices read of their device-held
// connectors and the workspace bindings. No credential is ever stored.
type DeviceConnectorStore interface {
	// SaveDeviceConnectorState replaces the device's record for the kind;
	// ExpiringSince is kept by the caller (connectors.DeviceHeld).
	SaveDeviceConnectorState(ctx context.Context, state DeviceConnectorState) error
	// ListDeviceConnectorStates lists the records of the devices named; none
	// named lists nothing.
	ListDeviceConnectorStates(ctx context.Context, deviceIDs []string) ([]DeviceConnectorState, error)
	// SetWorkspaceDeviceConnectors replaces the bindings userID granted in
	// the workspace; other people's stay.
	SetWorkspaceDeviceConnectors(ctx context.Context, workspaceID, userID string, bindings []DeviceConnectorBindingInput) error
	ListWorkspaceDeviceConnectors(ctx context.Context, workspaceID string) ([]DeviceConnectorBinding, error)
}
