package store

import (
	"context"
	"time"
)

// Where work may go (docs/devices-and-workspaces.md, "标签与检测到的事实";
// docs/personal-agent.md §4): what a device's owner says it has (labels)
// beside what Foundry detected from its worker's reports (facts). The
// assistant states what a new project needs in the same key:value words;
// these mirror packages/protocol/src/device-placement.ts.

// DeviceLabel is something a device's owner states about it: a free-form
// key with an optional value ("network: corp", "gpu", "always-on").
type DeviceLabel struct {
	Key   string `json:"key"`
	Value string `json:"value,omitempty"`
}

// DeviceFact is something Foundry detected about a device. Source is where
// it came from: "system" (os, arch), "toolchain", "gpu", "connector" (a
// connector's network check: reaches) or "presence" (always-on).
type DeviceFact struct {
	Key   string `json:"key"`
	Value string `json:"value,omitempty"`
	// Detail is for people: a version, the network a check names.
	Detail string `json:"detail,omitempty"`
	Source string `json:"source"`
}

// DeviceOnlineShare is how much of the last days a device was connected,
// as the server saw it.
type DeviceOnlineShare struct {
	// Ratio is the connected share of ObservedHours, 0 to 1.
	Ratio float64 `json:"ratio"`
	// ObservedHours is how far back the server followed it, at most a week.
	ObservedHours float64 `json:"observedHours"`
}

// DevicePlacement is one device's labels and detected facts
// (GET /api/device-placements, the caller's own devices).
type DevicePlacement struct {
	DeviceID    string             `json:"deviceId"`
	Labels      []DeviceLabel      `json:"labels"`
	Facts       []DeviceFact       `json:"facts"`
	OnlineShare *DeviceOnlineShare `json:"onlineShare,omitempty"`
	// LabelsUpdatedAt is when the owner last saved the labels.
	LabelsUpdatedAt string `json:"labelsUpdatedAt,omitempty"`
}

// SetDeviceLabelsInput replaces a device's labels
// (PUT /api/devices/{deviceId}/labels, its owner).
type SetDeviceLabelsInput struct {
	Labels []DeviceLabel `json:"labels"`
}

// DeviceLabelSet is a device's stored labels.
type DeviceLabelSet struct {
	DeviceID  string
	Labels    []DeviceLabel
	UpdatedBy string
	UpdatedAt string
}

// DevicePresenceInterval is one connection of a device: from StartedAt to
// LastSeenAt, which the server moves on while the connection lasts.
type DevicePresenceInterval struct {
	DeviceID   string
	StartedAt  time.Time
	LastSeenAt time.Time
}

// DevicePlacementStore keeps device labels and when devices were
// connected.
type DevicePlacementStore interface {
	// ListDeviceLabels answers the stored labels of the devices named.
	ListDeviceLabels(ctx context.Context, deviceIDs []string) ([]DeviceLabelSet, error)
	// SetDeviceLabels replaces a device's labels; none removes them.
	SetDeviceLabels(ctx context.Context, deviceID string, labels []DeviceLabel, userID string) error
	// RecordDevicePresence saves the connection that started at startedAt
	// as lasting until lastSeenAt.
	RecordDevicePresence(ctx context.Context, deviceID string, startedAt, lastSeenAt time.Time) error
	// ListDevicePresence answers the connections of the devices named that
	// lasted past since, oldest first.
	ListDevicePresence(ctx context.Context, deviceIDs []string, since time.Time) ([]DevicePresenceInterval, error)
	// PruneDevicePresence deletes connections that ended before before.
	PruneDevicePresence(ctx context.Context, before time.Time) error
}

// PersonalAgentNoPlaceStatus is PersonalAgentNoPlace's Status.
const PersonalAgentNoPlaceStatus = "no_place_fits"

// PersonalAgentNoPlace is create_workspace's answer when none of the
// computers the assistant may create on has what the work needs: the
// needs none of them gives (Missing) and each computer's gap. The
// assistant asks the person one plain question.
type PersonalAgentNoPlace struct {
	Status    string                  `json:"status"`
	Missing   []string                `json:"missing"`
	Computers []PersonalAgentPlaceGap `json:"computers"`
	// Next says, for the assistant, what to do now.
	Next string `json:"next"`
}

// PersonalAgentPlaceGap is one of the person's computers that does not
// fit: what it lacks, or why the assistant may not create there.
type PersonalAgentPlaceGap struct {
	Name       string   `json:"name"`
	DeviceID   string   `json:"deviceId"`
	Online     bool     `json:"online"`
	Lacks      []string `json:"lacks"`
	NotAllowed string   `json:"notAllowed,omitempty"`
}

// PersonalAgentPlacement is where create_workspace put a new project and
// why; Unverified are needs the computer the assistant named does not show.
type PersonalAgentPlacement struct {
	Computer   string   `json:"computer"`
	DeviceID   string   `json:"deviceId"`
	Online     bool     `json:"online"`
	Reason     string   `json:"reason"`
	Unverified []string `json:"unverified,omitempty"`
}
