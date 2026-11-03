package workspacedigest

import (
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DeviceSource is what a device digest is compiled from: one device the
// person owns, as the server keeps it.
type DeviceSource struct {
	Device store.DeviceProjection
	Online bool
	// Providers are its runtimes' health ("claude", "codex"), healthy or not.
	Providers []store.ProviderHealth
	// ModelServices are the names of the model services (profiles) enabled
	// on it.
	ModelServices []string
	// Resources are the types of its instances that are ready.
	Resources      []string
	WorkspaceCount int
}

// CompileDevice is the device's digest.
func CompileDevice(src DeviceSource, now time.Time) store.DeviceDigest {
	device := src.Device
	runtimes := []string{}
	for _, provider := range src.Providers {
		if provider.Status == "healthy" {
			runtimes = append(runtimes, provider.Provider)
		}
	}
	return store.DeviceDigest{
		DeviceID:       device.ID,
		Label:          device.Label,
		System:         deviceSystem(device.System),
		Online:         src.Online,
		Runtimes:       sortedUnique(runtimes),
		ModelServices:  sortedUnique(src.ModelServices),
		Resources:      sortedUnique(src.Resources),
		WorkspaceCount: src.WorkspaceCount,
		CompiledAt:     formatTime(now),
	}
}

func deviceSystem(system *store.DeviceSystem) string {
	if system == nil {
		return ""
	}
	name := map[string]string{"darwin": "macOS", "linux": "Linux", "win32": "Windows", "windows": "Windows"}[system.OS]
	if name == "" {
		name = system.OS
	}
	return strings.TrimSpace(name + " " + system.OSVersion)
}
