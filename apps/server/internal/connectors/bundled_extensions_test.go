package connectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Every extension shipped in extensions/ must pass the same descriptor checks
// the server applies to a device's report.
func TestBundledExtensionDescriptorsPassServerChecks(t *testing.T) {
	paths, err := filepath.Glob("../../../../extensions/*/foundry-extension.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("bundled extension manifests: %v, %v", paths, err)
	}
	for _, path := range paths {
		path := path
		t.Run(filepath.Base(filepath.Dir(path)), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var manifest struct {
				ID         string                      `json:"id"`
				Name       string                      `json:"name"`
				Version    string                      `json:"version"`
				Connectors []store.ConnectorDescriptor `json:"connectors"`
			}
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
			for _, descriptor := range manifest.Connectors {
				descriptor.Adapter = "extension:" + manifest.ID
				descriptor.Extension = &store.ConnectorExtensionSource{
					ID: manifest.ID, Name: manifest.Name, Version: manifest.Version,
				}
				if descriptor.ServerHeld != nil {
					descriptor.Holding = store.ConnectorServerHeld
				} else {
					descriptor.Holding = store.ConnectorDeviceHeld
				}
				if descriptor.Tool.Source == "" {
					descriptor.Tool.Source = "device"
				}
				if err := checkDescriptor(descriptor); err != nil {
					t.Errorf("%s: %v", descriptor.Kind, err)
				}
			}
		})
	}
}
