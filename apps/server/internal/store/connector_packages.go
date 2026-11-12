package store

import "context"

// ConnectorPackageProgress is where applying the selection stands on one
// device that is not simply installed (a device whose installation succeeded
// has none). Error says why it failed.
type ConnectorPackageProgress struct {
	State     ConnectorPackageDeviceState `json:"state"`
	Error     string                      `json:"error,omitempty"`
	UpdatedAt string                      `json:"updatedAt"`
}

// ConnectorPackageEnablement is a person's enabled package. Selected is what
// the person chose; Devices are those on which the tool and extension
// installation succeeded; States holds the devices still being changed or
// that failed. The package descriptor and bundle contents are not copied here.
type ConnectorPackageEnablement struct {
	OwnerUserID  string                              `json:"ownerUserId"`
	Kind         string                              `json:"kind"`
	ExtensionID  string                              `json:"extensionId"`
	RepositoryID string                              `json:"repositoryId"`
	Selected     []string                            `json:"selected"`
	Devices      []string                            `json:"devices"`
	States       map[string]ConnectorPackageProgress `json:"states,omitempty"`
	UpdatedAt    string                              `json:"updatedAt"`
}

// ConnectorPackageUnfinished reports whether a device still waits for or is
// under change.
func (e ConnectorPackageEnablement) Unfinished() bool {
	for _, state := range e.States {
		if state.State == ConnectorPackageDeviceStatePending || state.State == ConnectorPackageDeviceStateInstalling {
			return true
		}
	}
	return false
}

// ConnectorPackageStore keeps person-level package enablements.
type ConnectorPackageStore interface {
	GetConnectorPackage(ctx context.Context, ownerUserID, kind string) (ConnectorPackageEnablement, error)
	ListConnectorPackages(ctx context.Context, ownerUserID string) ([]ConnectorPackageEnablement, error)
	// ListAllConnectorPackages lists every person's enablements, to resume
	// the ones a restart interrupted.
	ListAllConnectorPackages(ctx context.Context) ([]ConnectorPackageEnablement, error)
	SaveConnectorPackage(ctx context.Context, packageEnablement ConnectorPackageEnablement) error
	DeleteConnectorPackage(ctx context.Context, ownerUserID, kind string) error
}
