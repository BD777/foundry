package store

import "context"

// ExtensionInstanceData is the validated, non-secret snapshot of one
// server-held extension instance. The descriptor is captured when the
// instance is created or checked, so every later request uses the same
// semantics even if another device reports a newer extension version.
type ExtensionInstanceData struct {
	Descriptor       ConnectorDescriptor              `json:"descriptor"`
	Values           map[string]string                `json:"values"`
	ProbeValues      map[string]string                `json:"probeValues,omitempty"`
	FieldOptions     map[string][]ConnectorOption     `json:"fieldOptions,omitempty"`
	Routes           []ConnectorServerHeldRoute       `json:"routes,omitempty"`
	Access           string                           `json:"access,omitempty"`
	Version          string                           `json:"version,omitempty"`
	StatusDetail     string                           `json:"statusDetail,omitempty"`
	Network          ConnectorServerHeldNetworkPath   `json:"network"`
	ProbeDeviceID    string                           `json:"probeDeviceId,omitempty"`
	AvailableDevices []ConnectorServerHeldDeviceCheck `json:"availableDevices,omitempty"`
}

// ExtensionServerHeldStore stores only the generic metadata column used by
// server-held extension instances. Credentials remain in the secret store.
type ExtensionServerHeldStore interface {
	SaveExternalProviderAppExtensionData(ctx context.Context, id, data string) (ExternalProviderApp, error)
	UpdateExternalProviderAppExtension(ctx context.Context, id, label, clientID, baseURL, data string) (ExternalProviderApp, error)
}
