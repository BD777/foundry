package externalaccounts

import (
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	ExtensionAccessRead  = "read"
	ExtensionAccessWrite = "write"
)

// ExtensionProbeValueReference parses probe:<probe-id>/<extracted-name>.
func ExtensionProbeValueReference(reference string) (probeID, name string, ok bool) {
	reference = strings.TrimPrefix(strings.TrimSpace(reference), "probe:")
	parts := strings.SplitN(reference, "/", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	probeID, name = strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
	return probeID, name, probeID != "" && name != ""
}

// ExtensionAccessLevels resolves the levels a validated instance's probe
// grants. A descriptor without allowBy keeps its fixed access levels.
func ExtensionAccessLevels(access store.ConnectorServerHeldAccess, probeValues map[string]string) []string {
	levels := access.Allow
	if strings.TrimSpace(access.AllowBy.Value) != "" {
		probeID, name, ok := ExtensionProbeValueReference(access.AllowBy.Value)
		if !ok {
			return nil
		}
		value := probeValues[probeID+"/"+name]
		var found bool
		levels, found = access.AllowBy.Map[value]
		if !found {
			levels = access.AllowBy.Otherwise
		}
	}
	return normalizeExtensionAccessLevels(levels)
}

// ExtensionAccessLevel is the highest level the instance currently grants.
func ExtensionAccessLevel(access store.ConnectorServerHeldAccess, probeValues map[string]string) string {
	levels := ExtensionAccessLevels(access, probeValues)
	for _, level := range levels {
		if level == ExtensionAccessWrite {
			return ExtensionAccessWrite
		}
	}
	if len(levels) > 0 {
		return ExtensionAccessRead
	}
	return ""
}

// ExtensionAccessAllowsRoute applies both the descriptor's probe-derived
// levels and the route's own read/write classification.
func ExtensionAccessAllowsRoute(access store.ConnectorServerHeldAccess, probeValues map[string]string, route store.ConnectorServerHeldRoute) bool {
	routeLevel := strings.ToLower(strings.TrimSpace(route.Access))
	for _, level := range ExtensionAccessLevels(access, probeValues) {
		if level == routeLevel {
			return true
		}
	}
	return false
}

func normalizeExtensionAccessLevels(levels []store.ConnectorServerHeldAccessLevel) []string {
	seen := map[string]bool{}
	var normalized []string
	for _, raw := range levels {
		level := strings.ToLower(strings.TrimSpace(string(raw)))
		if (level != ExtensionAccessRead && level != ExtensionAccessWrite) || seen[level] {
			continue
		}
		seen[level] = true
		normalized = append(normalized, level)
	}
	return normalized
}

// ExtensionRouteFor finds the validated catalog entry that governs a
// request. Catalog paths may contain :name or {name} placeholders; * and **
// match the rest of the path.
func ExtensionRouteFor(routes []store.ConnectorServerHeldRoute, method, path string) (store.ConnectorServerHeldRoute, bool) {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = normalizeExtensionRequestPath(path)
	for _, route := range routes {
		if !strings.EqualFold(strings.TrimSpace(route.Method), method) {
			continue
		}
		if extensionRoutePathMatches(route.Path, path) {
			return route, true
		}
	}
	return store.ConnectorServerHeldRoute{}, false
}

func ExtensionRouteAllowed(route store.ConnectorServerHeldRoute, allow []string) bool {
	access := strings.ToLower(strings.TrimSpace(route.Access))
	for _, level := range allow {
		if strings.EqualFold(strings.TrimSpace(level), access) {
			return true
		}
	}
	return false
}

func normalizeExtensionRequestPath(path string) string {
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
		if path == "" {
			return "/"
		}
	}
	return path
}

func extensionRoutePathMatches(template, path string) bool {
	template = normalizeExtensionRequestPath(template)
	path = normalizeExtensionRequestPath(path)
	if template == path {
		return true
	}
	want := strings.Split(strings.TrimPrefix(template, "/"), "/")
	got := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for index := 0; index < len(want); index++ {
		if want[index] == "*" || want[index] == "**" {
			return true
		}
		if index >= len(got) {
			return false
		}
		segment := want[index]
		if strings.HasPrefix(segment, ":") || (strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}")) {
			if got[index] == "" {
				return false
			}
			continue
		}
		if segment != got[index] {
			return false
		}
	}
	return len(want) == len(got)
}
