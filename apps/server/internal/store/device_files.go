package store

import (
	"context"
	"time"
)

// DeviceFileAccess is one time a device's owner opened a file of the device
// outside its workspaces from a chat: what was asked and how it ended,
// never the file's contents.
type DeviceFileAccess struct {
	DeviceID string    `json:"deviceId"`
	UserID   string    `json:"userId"`
	Path     string    `json:"path"`
	Action   string    `json:"action"`
	Result   string    `json:"result"`
	Bytes    int64     `json:"bytes,omitempty"`
	At       time.Time `json:"at"`
}

// DeviceFileStore keeps each device owner's switch for opening the device's
// files outside its workspaces (on unless turned off) and the record of
// each opening.
type DeviceFileStore interface {
	// DevicesWithOutsideFilesOff answers which of the devices named have it off.
	DevicesWithOutsideFilesOff(ctx context.Context, deviceIDs []string) (map[string]bool, error)
	SetDeviceOutsideFilesOff(ctx context.Context, deviceID string, off bool, userID string) error
	// RecordDeviceFileAccess keeps one opening and drops the device's
	// records older than the retention.
	RecordDeviceFileAccess(ctx context.Context, access DeviceFileAccess) error
	// ListDeviceFileAccess answers the device's latest openings, newest first.
	ListDeviceFileAccess(ctx context.Context, deviceID string, limit int) ([]DeviceFileAccess, error)
}

// DeviceFileAccessRetention is how long openings are kept.
const DeviceFileAccessRetention = 90 * 24 * time.Hour
