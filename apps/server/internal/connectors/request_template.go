package connectors

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A catalogued request's path and body are templates over named values. A
// placeholder is {name}; {name|json} places the value as the inside of a JSON
// string and is only for a body. A path value is path-escaped, a body value is
// inserted as it is, and a filled body must be JSON. The descriptor check and
// the runtime fill share this grammar, so a template that passes the check
// fills the same way the server sends it.
var requestPlaceholderPattern = regexp.MustCompile(`\{([a-zA-Z][a-zA-Z0-9.]*)(\|json)?\}`)

// requestPlaceholders is what a template may name: plain names for its path and
// body, and names that appear only as {name|json} in a body.
type requestPlaceholders struct {
	plain []string
	json  []string
}

// describe lists the placeholders a template of the given kind may use, for an error.
func (allowed requestPlaceholders) describe(body bool) string {
	names := make([]string, 0, len(allowed.plain)+len(allowed.json))
	for _, name := range allowed.plain {
		names = append(names, "{"+name+"}")
	}
	if body {
		for _, name := range allowed.json {
			names = append(names, "{"+name+"|json}")
		}
	}
	return strings.Join(names, ", ")
}

// FillRequestTemplate fills a request path (body false) or body (body true)
// template from values. A placeholder that values does not name, or {name|json}
// outside a body, is an error; so is a filled body that is not JSON.
func FillRequestTemplate(template string, values map[string]string, body bool) (string, error) {
	var failure error
	filled := requestPlaceholderPattern.ReplaceAllStringFunc(template, func(match string) string {
		if failure != nil {
			return ""
		}
		parts := requestPlaceholderPattern.FindStringSubmatch(match)
		value, known := values[parts[1]]
		asJSON := parts[2] != ""
		switch {
		case !known:
			failure = fmt.Errorf("template placeholder %s is not one of its values", match)
			return ""
		case asJSON && !body:
			failure = fmt.Errorf("template placeholder %s is only for a body", match)
			return ""
		case asJSON:
			escaped, err := jsonStringContent(value)
			failure = err
			return escaped
		case body:
			return value
		default:
			return url.PathEscape(value)
		}
	})
	if failure != nil {
		return "", failure
	}
	if body && !json.Valid([]byte(filled)) {
		return "", errors.New("the filled body is not JSON")
	}
	return filled, nil
}

// jsonStringContent is value escaped for the inside of a JSON string literal.
func jsonStringContent(value string) (string, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	quoted := strings.TrimSuffix(buf.String(), "\n")
	return quoted[1 : len(quoted)-1], nil
}

// checkRequestTemplate checks that a path or body template names only the
// placeholders allowed for it, and that a path has no stray braces.
func checkRequestTemplate(what, template string, body bool, allowed requestPlaceholders) error {
	for _, match := range requestPlaceholderPattern.FindAllStringSubmatch(template, -1) {
		name, asJSON := match[1], match[2] != ""
		switch {
		case asJSON && !body:
			return fmt.Errorf("%s: {%s|json} is only for a body", what, name)
		case asJSON && slices.Contains(allowed.json, name):
		case asJSON:
			return fmt.Errorf("%s may only use %s", what, allowed.describe(body))
		case slices.Contains(allowed.plain, name):
		case body && slices.Contains(allowed.json, name):
			return fmt.Errorf("%s: {%s} needs |json in a body", what, name)
		default:
			return fmt.Errorf("%s may only use %s", what, allowed.describe(body))
		}
	}
	if !body && strings.ContainsAny(requestPlaceholderPattern.ReplaceAllString(template, ""), "{}") {
		return fmt.Errorf("%s may only use %s", what, allowed.describe(body))
	}
	return nil
}

// checkFilledBody fills a body template with sample values and checks that it
// is JSON, so a placeholder that breaks the JSON is refused at save time.
func checkFilledBody(what, body string, samples map[string]string) error {
	if _, err := FillRequestTemplate(body, samples, true); err != nil {
		return fmt.Errorf("%s must be JSON: %w", what, err)
	}
	return nil
}

// checkCatalogedWriteCall checks a request a connector takes on the instance's
// behalf: a write method, a path at or below the upstream prefix, and a body of
// at most 1000 characters. Whether the route is in the instance's route
// directory is only known at runtime; the send checks it against that directory.
func checkCatalogedWriteCall(what, method, path, body, prefix string) error {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "POST", "PUT", "PATCH", "DELETE":
	default:
		return fmt.Errorf("%s.method is a write method", what)
	}
	if err := checkExtensionPath(what+".path", path); err != nil {
		return err
	}
	if path != prefix && !strings.HasPrefix(path, strings.TrimRight(prefix, "/")+"/") {
		return fmt.Errorf("%s.path must be at or below the upstream prefix %s", what, prefix)
	}
	if len(body) > 1000 {
		return fmt.Errorf("%s.body is at most 1000 characters", what)
	}
	return nil
}

// PointerText is the scalar at an RFC 6901 pointer into a response body, "" when
// the body has no string or scalar there.
func PointerText(payload []byte, pointer string) string {
	return extensionPointerText(payload, pointer)
}

// CheckWriteRoute checks that the instance's route directory lists method and
// the concrete path as a write its access allows, so a request the server makes
// on the instance's behalf is one the instance may send.
func CheckWriteRoute(data store.ExtensionInstanceData, method, path string) error {
	if data.Descriptor.ServerHeld == nil {
		return errors.New("the connector is not server-held")
	}
	route, ok := externalaccounts.ExtensionRouteFor(data.Routes, method, path)
	if !ok || !strings.EqualFold(strings.TrimSpace(route.Access), externalaccounts.ExtensionAccessWrite) ||
		!externalaccounts.ExtensionAccessAllowsRoute(data.Descriptor.ServerHeld.Access, data.ProbeValues, route) {
		return fmt.Errorf("the instance's route directory does not allow %s %s as a write; check the instance again", method, path)
	}
	return nil
}
