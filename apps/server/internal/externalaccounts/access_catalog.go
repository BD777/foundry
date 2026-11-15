package externalaccounts

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A built-in server-held connector declares its workspace access levels in
// access/<kind>.json: each level's name, the grant scopes it needs and the
// words the person reads when choosing it. A connector whose gateway is a
// route table also lists its routes there, so allowing another endpoint is
// a change to that file, not to the gateway.
//
//go:embed access/*.json
var accessFiles embed.FS

// AccessRoute is one request shape a level allows. Path segments in braces
// are identifiers: {zone}, {account} and {record} a 32-hex Cloudflare id,
// {id} an opaque id. Action names the change's own checks in the gateway;
// a GET has none. Query lists the parameters a read may take.
type AccessRoute struct {
	Methods []string `json:"methods"`
	Path    string   `json:"path"`
	Level   string   `json:"level"`
	Action  string   `json:"action,omitempty"`
	Query   []string `json:"query,omitempty"`
}

// AccessCatalog is one connector's access file.
type AccessCatalog struct {
	Levels []store.ExternalAccessLevel `json:"levels"`
	Routes []AccessRoute               `json:"routes,omitempty"`
}

// Level is the named level; "" is the first (the default).
func (c AccessCatalog) Level(name string) (store.ExternalAccessLevel, bool) {
	if name == "" && len(c.Levels) > 0 {
		return c.Levels[0], true
	}
	for _, level := range c.Levels {
		if level.Name == name {
			return level, true
		}
	}
	return store.ExternalAccessLevel{}, false
}

// LevelLabel is the level's English label, or its name.
func (c AccessCatalog) LevelLabel(name string) string {
	if level, ok := c.Level(name); ok && level.Label != "" {
		return level.Label
	}
	return name
}

func mustAccessCatalog(kind string) AccessCatalog {
	catalog, err := loadAccessCatalog(kind)
	if err != nil {
		panic(err)
	}
	return catalog
}

func loadAccessCatalog(kind string) (AccessCatalog, error) {
	raw, err := accessFiles.ReadFile("access/" + kind + ".json")
	if err != nil {
		return AccessCatalog{}, err
	}
	var catalog AccessCatalog
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&catalog); err != nil {
		return AccessCatalog{}, fmt.Errorf("access/%s.json: %w", kind, err)
	}
	if err := catalog.validate(); err != nil {
		return AccessCatalog{}, fmt.Errorf("access/%s.json: %w", kind, err)
	}
	return catalog, nil
}

var accessRouteMethods = []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete}

func (c AccessCatalog) validate() error {
	if len(c.Levels) == 0 {
		return fmt.Errorf("no levels")
	}
	seen := map[string]bool{}
	for _, level := range c.Levels {
		if level.Name == "" || seen[level.Name] {
			return fmt.Errorf("level %q is empty or repeated", level.Name)
		}
		seen[level.Name] = true
		if level.Label == "" || level.Description == "" {
			return fmt.Errorf("level %q needs a label and a description", level.Name)
		}
		if len(level.Scopes) > 0 && level.GrantHint == "" {
			return fmt.Errorf("level %q names scopes but no grantHint", level.Name)
		}
	}
	shapes := map[string]bool{}
	for _, route := range c.Routes {
		if !seen[route.Level] {
			return fmt.Errorf("route %s names unknown level %q", route.Path, route.Level)
		}
		if !strings.HasPrefix(route.Path, "/") || strings.Contains(route.Path, "//") || len(route.Methods) == 0 {
			return fmt.Errorf("route %q needs methods and an absolute path", route.Path)
		}
		for _, segment := range strings.Split(strings.TrimPrefix(route.Path, "/"), "/") {
			if strings.HasPrefix(segment, "{") && !slices.Contains([]string{"{zone}", "{account}", "{record}", "{id}"}, segment) {
				return fmt.Errorf("route %s: unknown identifier %s", route.Path, segment)
			}
		}
		for _, method := range route.Methods {
			if !slices.Contains(accessRouteMethods, method) {
				return fmt.Errorf("route %s: method %q", route.Path, method)
			}
			if (method == http.MethodGet) != (route.Action == "") {
				return fmt.Errorf("route %s %s: a read has no action and a change needs one", method, route.Path)
			}
			if method != http.MethodGet && len(route.Query) > 0 {
				return fmt.Errorf("route %s %s: a change takes no query parameters", method, route.Path)
			}
			key := method + " " + route.Path
			if shapes[key] {
				return fmt.Errorf("route %s is listed twice", key)
			}
			shapes[key] = true
		}
	}
	return nil
}
