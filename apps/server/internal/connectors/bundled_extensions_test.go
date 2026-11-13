package connectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Every extension shipped in extensions/ and every example under
// extensions/examples/ must pass the same descriptor checks the server applies
// to a device's report.
func TestExtensionDescriptorsPassServerChecks(t *testing.T) {
	bundled, err := filepath.Glob("../../../../extensions/*/foundry-extension.json")
	if err != nil || len(bundled) == 0 {
		t.Fatalf("bundled extension manifests: %v, %v", bundled, err)
	}
	examples, err := filepath.Glob("../../../../extensions/examples/*/foundry-extension.json")
	if err != nil || len(examples) < 3 {
		t.Fatalf("example extension manifests: %v, %v", examples, err)
	}
	paths := append(bundled, examples...)
	sort.Strings(paths)
	for _, path := range paths {
		path := path
		name := strings.TrimSuffix(strings.TrimPrefix(filepath.ToSlash(path), "../../../../extensions/"), "/foundry-extension.json")
		t.Run(name, func(t *testing.T) {
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

// tool.skills names Skills inside the tool's npm package: a tool installed
// any other way, or a folder outside the package, is refused.
func TestToolSkillsBelongToAnNPMPackage(t *testing.T) {
	descriptor := store.ConnectorDescriptor{
		Kind: "corpcli", Label: "corpcli", Adapter: "extension:corp",
		Extension: &store.ConnectorExtensionSource{ID: "corp", Name: "Corp", Version: "1.0.0"},
		Holding:   store.ConnectorDeviceHeld,
		Tool: store.ConnectorTool{
			Command: "corpcli", Source: "npm", Package: "@corp/cli", Registry: "device",
			Skills: &store.ConnectorToolSkills{Path: "skills"},
		},
	}
	if err := checkDescriptor(descriptor); err != nil {
		t.Fatalf("npm tool with skills: %v", err)
	}
	outside := descriptor
	outside.Tool.Skills = &store.ConnectorToolSkills{Path: "../skills"}
	if err := checkDescriptor(outside); err == nil || !strings.Contains(err.Error(), "tool.skills.path") {
		t.Fatalf("a folder outside the package: %v", err)
	}
	repeated := descriptor
	repeated.Tool.Skills = &store.ConnectorToolSkills{Path: "skills", Default: []string{"corp-search", "corp-search"}}
	if err := checkDescriptor(repeated); err == nil || !strings.Contains(err.Error(), "tool.skills.default") {
		t.Fatalf("a repeated default Skill: %v", err)
	}
	device := descriptor
	device.Tool = store.ConnectorTool{Command: "corpcli", Source: "device", Skills: &store.ConnectorToolSkills{Path: "skills"}}
	if err := checkDescriptor(device); err == nil || !strings.Contains(err.Error(), "npm package") {
		t.Fatalf("a device-installed tool with skills: %v", err)
	}
}
