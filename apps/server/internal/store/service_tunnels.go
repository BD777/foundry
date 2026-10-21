package store

import "context"

// ServiceTunnel is an explicitly registered web endpoint in Workspace Services.
// WorkID optionally associates an existing managed process; changing or closing
// a tunnel never changes that process's desired state.
type ServiceTunnel struct {
	HostLabel         string `json:"hostLabel,omitempty"`
	TargetWorkspaceID string `json:"targetWorkspaceId"`
	ID                string `json:"id"`
	WorkspaceID       string `json:"workspaceId"`
	DeviceID          string `json:"deviceId"`
	OwnerUserID       string `json:"ownerUserId"`
	WorkID            string `json:"workId,omitempty"`
	Name              string `json:"name"`
	Port              int    `json:"port"`
	Protocol          string `json:"protocol"`
	Visibility        string `json:"visibility"`
	Enabled           bool   `json:"enabled"`
	Revision          int64  `json:"revision"`
	CreatedAt         string `json:"createdAt"`
	UpdatedAt         string `json:"updatedAt"`
}

type ServiceTunnelStore interface {
	ListServiceTunnels(context.Context, string) ([]ServiceTunnel, error)
	GetServiceTunnel(context.Context, string) (ServiceTunnel, error)
	GetServiceTunnelByHostLabel(context.Context, string) (ServiceTunnel, error)
	CreateServiceTunnel(context.Context, ServiceTunnel) error
	UpdateServiceTunnel(context.Context, ServiceTunnel, int64) error
}

// ServiceTunnelView reports connection capability, not business health.
type ServiceTunnelView struct {
	ServiceTunnel
	DeviceLabel         string `json:"deviceLabel"`
	TargetWorkspaceName string `json:"targetWorkspaceName"`
	URL                 string `json:"url"`
	Status              string `json:"status"`
	CanManage           bool   `json:"canManage"`
}
type ServiceTunnelList struct {
	Items      []ServiceTunnelView   `json:"items"`
	CanManage  bool                  `json:"canManage"`
	Configured bool                  `json:"configured"`
	Targets    []WorkspaceProjection `json:"targets"`
}
type ServiceTunnelInput struct {
	TargetWorkspaceID string `json:"targetWorkspaceId,omitempty"`
	Name              string `json:"name"`
	Port              int    `json:"port"`
	Protocol          string `json:"protocol"`
	WorkID            string `json:"workId,omitempty"`
	Visibility        string `json:"visibility"`
	Enabled           bool   `json:"enabled"`
	ExpectedRevision  int64  `json:"expectedRevision,omitempty"`
	RegistrationKey   string `json:"registrationKey,omitempty"`
}
