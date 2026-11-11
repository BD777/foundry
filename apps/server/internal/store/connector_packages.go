package store

import "context"

// ConnectorPackageEnablement is a person's enabled package and the devices
// on which its tool and extension installation succeeded. The package
// descriptor and bundle contents are not copied here.
type ConnectorPackageEnablement struct {
	OwnerUserID  string   `json:"ownerUserId"`
	Kind         string   `json:"kind"`
	ExtensionID  string   `json:"extensionId"`
	RepositoryID string   `json:"repositoryId"`
	Devices      []string `json:"devices"`
	UpdatedAt    string   `json:"updatedAt"`
}

// ConnectorPackageStore keeps person-level package enablements.
type ConnectorPackageStore interface {
	GetConnectorPackage(ctx context.Context, ownerUserID, kind string) (ConnectorPackageEnablement, error)
	ListConnectorPackages(ctx context.Context, ownerUserID string) ([]ConnectorPackageEnablement, error)
	SaveConnectorPackage(ctx context.Context, packageEnablement ConnectorPackageEnablement) error
	DeleteConnectorPackage(ctx context.Context, ownerUserID, kind string) error
}
