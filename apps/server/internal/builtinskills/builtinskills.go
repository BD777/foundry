// Package builtinskills holds the skills Foundry itself gives an agent: a
// third kind beside the skills an agent ships (read from the device) and the
// skills a workspace selects. A session on that agent always has them,
// delivered like any workspace skill package. See SOURCE.md for where each
// comes from.
package builtinskills

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"path"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
)

//go:embed all:skill-creator
var files embed.FS

// Skill is one Foundry built-in skill, packaged as the workers expect: a zip
// whose root holds SKILL.md.
type Skill struct {
	ID          string
	Runtime     string
	Name        string
	Description string
	// Source names where the skill comes from, for people to see.
	Source   string
	Revision int
	Package  []byte
	Checksum string
}

type definition struct {
	dir, runtime, source string
	revision             int
}

// Bump a revision whenever its folder changes, so workers fetch it again.
var definitions = []definition{
	{dir: "skill-creator", runtime: "claude", source: "Anthropic skills", revision: 1},
}

var skills = mustBuild()

// ForRuntime lists the built-in skills of an agent runtime ("claude", "codex").
func ForRuntime(runtime string) []Skill {
	var out []Skill
	for _, skill := range skills {
		if skill.Runtime == runtime {
			out = append(out, skill)
		}
	}
	return out
}

// All lists every built-in skill.
func All() []Skill { return append([]Skill(nil), skills...) }

// Lookup finds a built-in skill by its catalog id.
func Lookup(id string) (Skill, bool) {
	for _, skill := range skills {
		if skill.ID == id {
			return skill, true
		}
	}
	return Skill{}, false
}

func mustBuild() []Skill {
	out := make([]Skill, 0, len(definitions))
	for _, def := range definitions {
		pkg, _, err := skillarchive.PackDir(files, def.dir)
		if err != nil {
			panic("builtinskills: " + def.dir + ": " + err.Error())
		}
		manifest, err := fs.ReadFile(files, path.Join(def.dir, "SKILL.md"))
		if err != nil {
			panic("builtinskills: " + def.dir + ": " + err.Error())
		}
		name, description := frontmatter(string(manifest))
		if name == "" {
			name = def.dir
		}
		sum := sha256.Sum256(pkg)
		out = append(out, Skill{
			ID:          "builtin-" + def.runtime + "-" + name,
			Runtime:     def.runtime,
			Name:        name,
			Description: description,
			Source:      def.source,
			Revision:    def.revision,
			Package:     pkg,
			Checksum:    hex.EncodeToString(sum[:]),
		})
	}
	return out
}

// frontmatter reads name and description from a SKILL.md header.
func frontmatter(text string) (name, description string) {
	if !strings.HasPrefix(text, "---") {
		return "", ""
	}
	rest := text[3:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", ""
	}
	for _, line := range strings.Split(rest[:end], "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			name = value
		case "description":
			description = value
		}
	}
	return name, description
}
