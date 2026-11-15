package connectors

import (
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// cloudflareRoute is a request matched against access/cloudflare.json: the
// route, and the zone or account its path names.
type cloudflareRoute struct {
	externalaccounts.AccessRoute
	zone, account string
}

// matchCloudflareRoute is the route for this method and path, if the file
// lists one.
func matchCloudflareRoute(method, path string) (cloudflareRoute, bool) {
	for _, route := range externalaccounts.CloudflareAccess.Routes {
		if !slices.Contains(route.Methods, method) {
			continue
		}
		if match, ok := cloudflareRoutePath(route, path); ok {
			return match, true
		}
	}
	return cloudflareRoute{}, false
}

// cloudflareRoutePath matches the path alone.
func cloudflareRoutePath(route externalaccounts.AccessRoute, path string) (cloudflareRoute, bool) {
	want := strings.Split(strings.TrimPrefix(route.Path, "/"), "/")
	got := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(want) != len(got) {
		return cloudflareRoute{}, false
	}
	match := cloudflareRoute{AccessRoute: route}
	for i, segment := range want {
		switch segment {
		case "{zone}", "{account}", "{record}":
			if !cloudflareZoneID.MatchString(got[i]) {
				return cloudflareRoute{}, false
			}
			if segment == "{zone}" {
				match.zone = got[i]
			} else if segment == "{account}" {
				match.account = got[i]
			}
		case "{id}":
			if !cloudflareOpaqueID.MatchString(got[i]) {
				return cloudflareRoute{}, false
			}
		default:
			if segment != got[i] {
				return cloudflareRoute{}, false
			}
		}
	}
	return match, true
}

// cloudflareKnownPath is the route template a path matches under any
// method, with its identifiers as ":id" (for audit lines), or "".
func cloudflareKnownPath(path string) string {
	for _, route := range externalaccounts.CloudflareAccess.Routes {
		if _, ok := cloudflareRoutePath(route, path); ok {
			parts := strings.Split(route.Path, "/")
			for i, part := range parts {
				if strings.HasPrefix(part, "{") {
					parts[i] = ":id"
				}
			}
			return strings.Join(parts, "/")
		}
	}
	return ""
}

// cloudflareRoutesText lists the routes that pass keep, with the level each
// needs, for a refusal: "POST /zones/<zone>/dns_records (dns_edit), …".
func cloudflareRoutesText(keep func(method string, route externalaccounts.AccessRoute) bool) string {
	var out []string
	for _, route := range externalaccounts.CloudflareAccess.Routes {
		var methods []string
		for _, method := range route.Methods {
			if keep(method, route) {
				methods = append(methods, method)
			}
		}
		if len(methods) > 0 {
			shown := strings.NewReplacer("{", "<", "}", ">").Replace(route.Path)
			out = append(out, strings.Join(methods, "/")+" "+shown+" ("+route.Level+")")
		}
	}
	return strings.Join(out, ", ")
}

// cloudflareLevelBelow: held ranks below needed in access/cloudflare.json.
func cloudflareLevelBelow(held, needed string) bool {
	rank := func(name string) int {
		return slices.IndexFunc(externalaccounts.CloudflareAccess.Levels, func(l store.ExternalAccessLevel) bool { return l.Name == name })
	}
	return rank(held) < rank(needed)
}
