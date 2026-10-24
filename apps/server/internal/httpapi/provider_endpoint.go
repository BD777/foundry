package httpapi

import (
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// The base URL of a compatible model provider as its runtime expects it.
// Claude Code calls <base>/v1/messages, so its base carries no /v1; Codex
// calls <base>/responses, so its base carries the version. A pasted endpoint
// URL or the other runtime's convention otherwise fails every run as an
// unknown model (/v1/v1/messages answers 404). Same rules as the protocol's
// normalizeProviderBaseUrl (packages/protocol/src/provider-endpoint.ts),
// checked against the shared provider-endpoint-fixtures.json.

const (
	endpointSchemeAdded        = "scheme_added"
	endpointPathRemoved        = "endpoint_path_removed"
	endpointVersionRemoved     = "version_removed"
	endpointVersionAdded       = "version_added"
	endpointErrorEmpty         = "empty"
	endpointErrorInvalidURL    = "invalid_url"
	endpointErrorScheme        = "unsupported_scheme"
	endpointErrorCredentials   = "credentials_in_url"
	endpointErrorQueryFragment = "query_or_fragment"
)

var (
	endpointHasScheme = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	endpointParts     = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*)://([^/?#]*)([^?#]*)(.*)$`)
	endpointLoopback  = regexp.MustCompile(`(?i)^(localhost|127\.|0\.0\.0\.0|\[::1\])`)
	endpointSuffixes  = map[string][]string{
		"claude": {"/messages", "/models", "/chat/completions"},
		"codex":  {"/responses", "/chat/completions", "/completions", "/models"},
	}
	// endpointErrorMessages answer a caller whose base URL cannot be used.
	endpointErrorMessages = map[string]string{
		endpointErrorEmpty:         "baseUrl is required for custom profiles",
		endpointErrorInvalidURL:    "baseUrl must be a URL such as https://gateway.example.com",
		endpointErrorScheme:        "baseUrl must start with https:// or http://",
		endpointErrorCredentials:   "baseUrl must not carry credentials; put the key in apiKey",
		endpointErrorQueryFragment: "baseUrl must not carry a query string or #fragment",
	}
)

// normalizeProviderBaseURL returns the runtime's form of raw and the
// corrections made to reach it, or an error code. addMissingVersion gives a
// bare Codex host /v1; repairing an older saved value passes false.
func normalizeProviderBaseURL(runtime, raw string, addMissingVersion bool) (string, []string, string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil, endpointErrorEmpty
	}
	if strings.ContainsFunc(value, unicode.IsSpace) {
		return "", nil, endpointErrorInvalidURL
	}
	corrections := []string{}
	if !endpointHasScheme.MatchString(value) {
		host := value
		if end := strings.IndexAny(value, "/?#"); end >= 0 {
			host = value[:end]
		}
		scheme := "https"
		if endpointLoopback.MatchString(host) {
			scheme = "http"
		}
		value = scheme + "://" + value
		corrections = append(corrections, endpointSchemeAdded)
	}
	match := endpointParts.FindStringSubmatch(value)
	if match == nil {
		return "", nil, endpointErrorInvalidURL
	}
	scheme, authority, path := strings.ToLower(match[1]), match[2], match[3]
	if scheme != "http" && scheme != "https" {
		return "", nil, endpointErrorScheme
	}
	if authority == "" || strings.HasPrefix(authority, ":") {
		return "", nil, endpointErrorInvalidURL
	}
	if strings.Contains(authority, "@") {
		return "", nil, endpointErrorCredentials
	}
	if match[4] != "" {
		return "", nil, endpointErrorQueryFragment
	}

	path = strings.TrimRight(path, "/")
	suffixes := endpointSuffixes["codex"]
	if runtime == "claude" {
		suffixes = endpointSuffixes["claude"]
	}
	for removed := true; removed; {
		removed = false
		for _, suffix := range suffixes {
			if strings.HasSuffix(strings.ToLower(path), suffix) {
				path = strings.TrimRight(path[:len(path)-len(suffix)], "/")
				if !slices.Contains(corrections, endpointPathRemoved) {
					corrections = append(corrections, endpointPathRemoved)
				}
				removed = true
			}
		}
	}
	if runtime == "claude" && strings.HasSuffix(strings.ToLower(path), "/v1") {
		path = strings.TrimRight(path[:len(path)-len("/v1")], "/")
		corrections = append(corrections, endpointVersionRemoved)
	}
	if runtime == "codex" && path == "" && !slices.Contains(corrections, endpointPathRemoved) && addMissingVersion {
		path = "/v1"
		corrections = append(corrections, endpointVersionAdded)
	}
	return scheme + "://" + authority + path, corrections, ""
}

// sameProviderEndpoint says whether two base URLs of a runtime call the same
// endpoint once each is repaired as a run would (a device's Claude base may
// still end in /v1 while its promoted copy was corrected).
func sameProviderEndpoint(runtime, a, b string) bool {
	repair := func(raw string) string {
		if baseURL, _, code := normalizeProviderBaseURL(runtime, raw, false); code == "" {
			return baseURL
		}
		return strings.TrimSpace(raw)
	}
	return repair(a) == repair(b)
}
