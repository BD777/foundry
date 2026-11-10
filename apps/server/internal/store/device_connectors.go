package store

import "context"

// Connectors: the catalog every connector is described by, and the
// device-held kind, whose credential never leaves the device (the AWS CLI,
// and what connector extensions provide). The server keeps only what a
// device read of it: whether it is installed and signed in, the identity
// label the tool shows, the sites and when the login ends; and which
// workspaces may use which device's login.
// These mirror packages/protocol/src/connectors.ts.

// Connector holdings: who keeps a connector's credential.
const (
	ConnectorServerHeld = "server_held"
	ConnectorDeviceHeld = "device_held"
)

type ConnectorAuthorizationChallenge struct {
	Kind        string `json:"kind"`
	URL         string `json:"url,omitempty"`
	UserCode    string `json:"userCode,omitempty"`
	ImageURL    string `json:"imageUrl,omitempty"`
	Instruction string `json:"instruction,omitempty"`
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
	// CodeEntry: the person pastes back a code shown after approving.
	CodeEntry bool `json:"codeEntry,omitempty"`
	// CodeEntryFormat "callback_url": what is pasted is the address the
	// browser landed on after approving, not a code the page shows.
	CodeEntryFormat string `json:"codeEntryFormat,omitempty"`
}

// ConnectorProgressPayload is connector_progress: how a running install
// is going on the device (worker → server, not answered). At is when the
// server received it.
type ConnectorProgressPayload struct {
	Kind           string `json:"kind"`
	Phase          string `json:"phase"`
	ReceivedBytes  int64  `json:"receivedBytes,omitempty"`
	TotalBytes     int64  `json:"totalBytes,omitempty"`
	BytesPerSecond int64  `json:"bytesPerSecond,omitempty"`
	At             string `json:"at,omitempty"`
}

// DeviceConnectorDevice is one of the person's devices with its
// device-held connectors.
type DeviceConnectorDevice struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Online   bool   `json:"online"`
	// ExtensionKinds are the kinds an extension on the device provides.
	ExtensionKinds []string `json:"extensionKinds,omitempty"`
	// Extensions are the extensions installed on the device: version,
	// source and the commits it installed and sees upstream.
	Extensions []ConnectorExtensionSource `json:"extensions,omitempty"`
	// Checking: connector kinds being read on the device right now; their
	// states are the last readings until the read lands.
	Checking []string `json:"checking,omitempty"`
	// Progress: installs running on the device, their latest report each.
	Progress []ConnectorProgressPayload `json:"progress,omitempty"`
	States   []DeviceConnectorState     `json:"states"`
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
	// SignInOptions: what the person chose for sign_in_begin (connector-specific).
	SignInOptions map[string]string `json:"signInOptions,omitempty"`
	// Configuration: non-secret profile settings a configure action changes.
	Configuration *ConnectorConfiguration `json:"configuration,omitempty"`
	// Input: what the person typed for sign_in_input (an authorization code).
	Input string `json:"input,omitempty"`
}

// ExtensionRequestPayload is extension_request: for the device's owner,
// install or update an extension from a git folder, or remove one.
type ExtensionRequestPayload struct {
	Action      string                        `json:"action"`
	Source      *ConnectorExtensionRepository `json:"source,omitempty"`
	ExtensionID string                        `json:"extensionId,omitempty"`
}

// InstalledExtension is what the device says it installed (no paths kept).
type InstalledExtension struct {
	ID           string                        `json:"id"`
	Name         string                        `json:"name"`
	Version      string                        `json:"version"`
	Connectors   []string                      `json:"connectors"`
	Source       *ConnectorExtensionRepository `json:"source,omitempty"`
	Commit       string                        `json:"commit,omitempty"`
	LatestCommit string                        `json:"latestCommit,omitempty"`
}

// ExtensionReplyPayload is extension_reply.
type ExtensionReplyPayload struct {
	Action    string              `json:"action,omitempty"`
	Extension *InstalledExtension `json:"extension,omitempty"`
	Error     string              `json:"error,omitempty"`
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
	// DeviceExtensionConnectors lists, per device named, the connectors its
	// extensions provide as its last registration reported them.
	DeviceExtensionConnectors(ctx context.Context, deviceIDs []string) (map[string][]ConnectorDescriptor, error)
}

// ConnectorCatalogView is GET /api/connectors: the built-in connectors and
// those extensions on the caller's own devices provide.
type ConnectorCatalogView struct {
	Connectors []ConnectorDescriptor `json:"connectors"`
}
