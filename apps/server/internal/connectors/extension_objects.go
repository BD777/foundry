package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A write declaration names the objects it touches; a resolver turns one
// object type into another through a catalogued read route (a message into
// its conversation), so a grant on the conversation covers replies to any
// message in it (DEV-265). Results are cached per account.
const (
	extensionResolverDefaultTTL = 10 * time.Minute
	extensionResolverFailureTTL = time.Minute
	extensionResolverMaxEntries = 1024
)

// extensionResolved is one cached resolver answer.
type extensionResolved struct {
	value     string
	ok        bool
	expiresAt time.Time
}

// extensionResolverCache is a small bounded cache: expired entries are
// dropped on read and the oldest write goes when the cache is full.
type extensionResolverCache struct {
	mu      sync.Mutex
	entries map[string]extensionResolved
	order   []string
}

func (c *extensionResolverCache) get(key string, now time.Time) (string, bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return "", false, false
	}
	if now.After(entry.expiresAt) {
		delete(c.entries, key)
		c.order = slicesWithout(c.order, key)
		return "", false, false
	}
	return entry.value, entry.ok, true
}

func (c *extensionResolverCache) put(key, value string, ok bool, now time.Time, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]extensionResolved{}
	}
	if _, exists := c.entries[key]; !exists {
		c.order = append(c.order, key)
		if len(c.order) > extensionResolverMaxEntries {
			oldest := c.order[0]
			c.order = c.order[1:]
			delete(c.entries, oldest)
		}
	}
	c.entries[key] = extensionResolved{value: value, ok: ok, expiresAt: now.Add(ttl)}
}

func slicesWithout(values []string, remove string) []string {
	out := values[:0]
	for _, value := range values {
		if value != remove {
			out = append(out, value)
		}
	}
	return out
}

func normalizeExtensionPath(path string) string {
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		return "/" + path
	}
	return path
}

// extensionPathParams matches a concrete call path against the declared
// template and returns its named parameter values.
func extensionPathParams(template, path string) (map[string]string, bool) {
	want := splitExtensionPath(normalizeExtensionPath(template))
	got := splitExtensionPath(normalizeExtensionPath(path))
	if len(want) != len(got) {
		return nil, false
	}
	params := map[string]string{}
	for index, segment := range want {
		switch {
		case strings.HasPrefix(segment, ":"):
			if got[index] == "" {
				return nil, false
			}
			params[segment[1:]] = got[index]
		case strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}"):
			if got[index] == "" {
				return nil, false
			}
			params[segment[1:len(segment)-1]] = got[index]
		case segment != got[index]:
			return nil, false
		}
	}
	return params, true
}

func splitExtensionPath(path string) []string {
	if path == "/" || path == "" {
		return nil
	}
	return strings.Split(strings.Trim(path, "/"), "/")
}

// extensionSubstitutePath fills the read route's one parameter with id.
func extensionSubstitutePath(template, id string) (string, bool) {
	segments := strings.Split(strings.Trim(normalizeExtensionPath(template), "/"), "/")
	count := 0
	for index, segment := range segments {
		if !strings.HasPrefix(segment, ":") && !(strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}")) {
			continue
		}
		count++
		if id == "" {
			return "", false
		}
		segments[index] = url.PathEscape(id)
	}
	if count != 1 {
		return "", false
	}
	return "/" + strings.Join(segments, "/"), true
}

// extensionWriteDeclaration is the descriptor's declaration for a write
// route, when it has one.
func extensionWriteDeclaration(writes []store.ConnectorServerHeldWrite, method, route string) (store.ConnectorServerHeldWrite, bool) {
	for _, write := range writes {
		if strings.EqualFold(strings.TrimSpace(write.Method), method) &&
			externalaccounts.ExtensionRoutePathMatches(write.Path, route) {
			return write, true
		}
	}
	return store.ConnectorServerHeldWrite{}, false
}

// extensionWriteFacts is what a write declaration says about one request:
// the body Foundry would send, the grant objects it touches with their names
// for the person, and the message's own words.
type extensionWriteFacts struct {
	Body    []byte
	Objects []permission.GrantObject
	Labels  []gateway.ObjectLabel
	Text    string
	OK      bool
}

// writeObjects reads the request body, applies the channel footer when the
// declaration carries one, and resolves every object the write touches to
// the type a grant names. OK is false when a declared object cannot be read
// or resolved: the write then stays outside every grant. Names are looked up
// here, when the proposal is made, never when the person's page renders.
func (p *extensionGatewayProvider) writeObjects(ctx context.Context, r *http.Request, lease *gateway.Lease, routes []store.ConnectorServerHeldRoute, resolvers []store.ConnectorServerHeldResolver, labels []store.ConnectorServerHeldLabel, write store.ConnectorServerHeldWrite, callPath string) extensionWriteFacts {
	body, original, ok := p.effectiveBody(ctx, r, lease, write)
	if !ok {
		return extensionWriteFacts{}
	}
	params, paramsOK := extensionPathParams(write.Path, callPath)
	var document any
	if write.Footer != nil || extensionWriteReadsBody(write) {
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.UseNumber()
		if decoder.Decode(&document) != nil {
			return extensionWriteFacts{Body: body}
		}
	}
	text := ""
	if write.Footer != nil {
		// The item shows the message's own words; the channel's footer is
		// appended to the body Foundry sends, not to what the person reads.
		var readable any
		decoder := json.NewDecoder(bytes.NewReader(original))
		decoder.UseNumber()
		if decoder.Decode(&readable) == nil {
			text, _ = extensionPointerString(readable, write.Footer.Text)
		}
	}
	if len(write.Objects) == 0 {
		return extensionWriteFacts{Body: body, Text: text, OK: true}
	}
	objects := []permission.GrantObject{}
	for _, object := range write.Objects {
		values, valuesOK := extensionObjectValues(object, params, paramsOK, document)
		if !valuesOK || len(values) == 0 {
			return extensionWriteFacts{Body: body, Text: text}
		}
		for _, value := range values {
			resolved, resolvedOK := p.resolveObject(ctx, lease, resolvers, object.Type, value)
			if !resolvedOK {
				return extensionWriteFacts{Body: body, Text: text}
			}
			if !extensionContainsObject(objects, resolved) {
				objects = append(objects, resolved)
			}
		}
	}
	named := make([]gateway.ObjectLabel, 0, len(objects))
	for _, object := range objects {
		named = append(named, p.nameObject(ctx, lease, routes, labels, object))
	}
	return extensionWriteFacts{Body: body, Objects: objects, Labels: named, Text: text, OK: true}
}

// nameObject asks the descriptor's label route for one object's name. A
// failure leaves the name empty; the person's card then shows the id as
// unknown rather than calling out.
func (p *extensionGatewayProvider) nameObject(ctx context.Context, lease *gateway.Lease, routes []store.ConnectorServerHeldRoute, labels []store.ConnectorServerHeldLabel, object permission.GrantObject) gateway.ObjectLabel {
	named := gateway.ObjectLabel{Type: object.Type, ID: object.ID}
	label, ok := extensionLabelFor(labels, object.Type)
	if !ok {
		return named
	}
	path, ok := extensionSubstitutePath(label.Path, object.ID)
	if !ok {
		return named
	}
	route, ok := externalaccounts.ExtensionRouteFor(routes, label.Method, path)
	if !ok || strings.ToLower(strings.TrimSpace(route.Access)) != extensionGatewayRead {
		return named
	}
	now := p.gateway.Now()
	key := "label\x00" + lease.Account.ID + "\x00" + object.Type + "\x00" + object.ID
	if value, found, cached := p.gateway.resolve.get(key, now); cached {
		if found {
			named.Name = value
		}
		return named
	}
	value, found := p.callResolver(ctx, lease, label.Method, path, label.Pointer)
	ttl := time.Duration(label.TTLSeconds) * time.Second
	if !found {
		ttl = extensionResolverFailureTTL
	} else if ttl <= 0 {
		ttl = extensionResolverDefaultTTL
	}
	p.gateway.resolve.put(key, value, found, now, ttl)
	if found {
		named.Name = value
	}
	return named
}

func extensionLabelFor(labels []store.ConnectorServerHeldLabel, objectType string) (store.ConnectorServerHeldLabel, bool) {
	for _, label := range labels {
		if strings.EqualFold(strings.TrimSpace(label.Object), objectType) {
			return label, true
		}
	}
	return store.ConnectorServerHeldLabel{}, false
}

// effectiveBody is the body Foundry would send for the write, with the
// channel's footer appended when the descriptor declares where it goes.
func (p *extensionGatewayProvider) effectiveBody(ctx context.Context, r *http.Request, lease *gateway.Lease, write store.ConnectorServerHeldWrite) ([]byte, []byte, bool) {
	var raw []byte
	if r.Body != nil && r.Body != http.NoBody {
		read, err := io.ReadAll(io.LimitReader(r.Body, maxExtensionRequestBody+1))
		_ = r.Body.Close()
		if err != nil || len(read) > maxExtensionRequestBody {
			return nil, nil, false
		}
		raw = read
	}
	original := raw
	if write.Footer != nil && len(raw) > 0 && p.gateway.footer != nil && lease != nil && lease.Grant.SessionID != "" {
		if line, add := p.gateway.footer(ctx, lease.Grant.AccountID, lease.Grant.SessionID); add && line != "" {
			if rewritten, changed := extensionAppendFooter(raw, *write.Footer, line); changed {
				raw = rewritten
			}
		}
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	return raw, original, true
}

// extensionWriteReadsBody reports whether a declaration reads the body.
func extensionWriteReadsBody(write store.ConnectorServerHeldWrite) bool {
	for _, object := range write.Objects {
		if !strings.HasPrefix(object.From, ":") {
			return true
		}
	}
	return false
}

// extensionObjectValues reads one declaration's ids from the path or body.
func extensionObjectValues(object store.ConnectorServerHeldWriteObject, params map[string]string, paramsOK bool, document any) ([]string, bool) {
	if name, ok := strings.CutPrefix(object.From, ":"); ok {
		if !paramsOK {
			return nil, false
		}
		value := params[name]
		if value == "" {
			return nil, false
		}
		return []string{value}, true
	}
	if !object.Each {
		value, ok := extensionPointerString(document, object.From)
		if !ok || value == "" {
			return nil, false
		}
		return []string{value}, true
	}
	raw, ok := extensionPointerValue(document, object.From)
	if !ok {
		return nil, false
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		value, ok := item.(string)
		if !ok || value == "" {
			return nil, false
		}
		values = append(values, value)
	}
	return values, true
}

func extensionContainsObject(objects []permission.GrantObject, want permission.GrantObject) bool {
	for _, object := range objects {
		if object == want {
			return true
		}
	}
	return false
}

// resolveObject maps one id to the grant object a declaration names. A type
// with no resolver is already the grant type (a conversation).
func (p *extensionGatewayProvider) resolveObject(ctx context.Context, lease *gateway.Lease, resolvers []store.ConnectorServerHeldResolver, objectType, id string) (permission.GrantObject, bool) {
	resolver, ok := extensionResolverFor(resolvers, objectType)
	if !ok {
		return permission.GrantObject{Type: objectType, ID: id}, true
	}
	path, pathOK := extensionSubstitutePath(resolver.Path, id)
	if !pathOK {
		return permission.GrantObject{}, false
	}
	now := p.gateway.Now()
	key := lease.Account.ID + "\x00" + objectType + "\x00" + resolver.To + "\x00" + id
	if value, found, cached := p.gateway.resolve.get(key, now); cached {
		if !found {
			return permission.GrantObject{}, false
		}
		return permission.GrantObject{Type: resolver.To, ID: value}, true
	}
	value, found := p.callResolver(ctx, lease, resolver.Method, path, resolver.Pointer)
	ttl := time.Duration(resolver.TTLSeconds) * time.Second
	if !found {
		ttl = extensionResolverFailureTTL
	} else if ttl <= 0 {
		ttl = extensionResolverDefaultTTL
	}
	p.gateway.resolve.put(key, value, found, now, ttl)
	if !found {
		return permission.GrantObject{}, false
	}
	return permission.GrantObject{Type: resolver.To, ID: value}, true
}

func extensionResolverFor(resolvers []store.ConnectorServerHeldResolver, objectType string) (store.ConnectorServerHeldResolver, bool) {
	for _, resolver := range resolvers {
		if strings.EqualFold(strings.TrimSpace(resolver.From), objectType) {
			return resolver, true
		}
	}
	return store.ConnectorServerHeldResolver{}, false
}

func (p *extensionGatewayProvider) callResolver(ctx context.Context, lease *gateway.Lease, method, path, pointer string) (string, bool) {
	resolveCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	response, err := p.gateway.accounts.DoExtensionRequest(resolveCtx, lease.App, lease.Grant.DeviceID, method, path, nil, http.Header{}, nil)
	if err != nil {
		return "", false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", false
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 256<<10))
	if err != nil {
		return "", false
	}
	value := extensionPointerText(payload, pointer)
	return value, value != ""
}
