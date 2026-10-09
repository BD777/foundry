package skillarchive

import (
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

var frontmatterPattern = regexp.MustCompile(`(?s)^---\n(.*?)\n---(?:\n|$)`)

// Manifest is the frontmatter of a SKILL.md (Agent Skills format).
type Manifest struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	License     string `yaml:"license"`
	Metadata    struct {
		// Requires names the programs the skill runs, as a list or a
		// comma- or space-separated string.
		Requires any `yaml:"requires"`
	} `yaml:"metadata"`
}

// ReadManifest parses SKILL.md frontmatter; a file without one has none.
func ReadManifest(text string) (Manifest, error) {
	raw := strings.ReplaceAll(text, "\r\n", "\n")
	match := frontmatterPattern.FindStringSubmatch(raw)
	if match == nil {
		return Manifest{}, nil
	}
	var manifest Manifest
	err := yaml.Unmarshal([]byte(match[1]), &manifest)
	manifest.Name = strings.TrimSpace(manifest.Name)
	manifest.Description = strings.TrimSpace(manifest.Description)
	manifest.License = strings.TrimSpace(manifest.License)
	return manifest, err
}
