package externalaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ErrScopesUnsupported: a login named a scope its provider does not list.
var ErrScopesUnsupported = errors.New("unsupported scopes")

// ScopeCataloger is a provider whose scopes a person chooses from a list
// (DEV-136). app is the app a login would go through; nil before one
// exists (a Feishu app created during sign-in).
type ScopeCataloger interface {
	ScopeCatalog(ctx context.Context, app *AppCredentials) (store.ExternalScopeCatalog, error)
}

// ScopeCatalog is the list a login through app (nil: none yet) chooses
// from. The caller checks that the person may use app.
func (s *Service) ScopeCatalog(ctx context.Context, kind string, app *store.ExternalProviderApp) (store.ExternalScopeCatalog, error) {
	if err := s.Integrations.Err(); err != nil {
		return store.ExternalScopeCatalog{}, err
	}
	provider, err := s.serverHeld(kind)
	if err != nil {
		return store.ExternalScopeCatalog{}, err
	}
	cataloger, ok := provider.(ScopeCataloger)
	if !ok {
		return store.ExternalScopeCatalog{}, fmt.Errorf("%s lists no scopes", kind)
	}
	var credentials *AppCredentials
	if app != nil {
		found, err := s.AppCredentials(ctx, *app)
		if err != nil {
			return store.ExternalScopeCatalog{}, err
		}
		credentials = &found
	}
	return cataloger.ScopeCatalog(ctx, credentials)
}

// requestedScopes is what a login asks for: the provider's preset when
// none are named, else the named ones, each listed in its catalog; the
// provider's always-scopes (offline_access…) are added either way.
func requestedScopes(ctx context.Context, provider ServerHeldProvider, app *AppCredentials, named []string) ([]string, error) {
	always := provider.Describe().AlwaysScopes
	if len(named) == 0 {
		return mergeScopes(always, provider.PresetScopes(false)), nil
	}
	if cataloger, ok := provider.(ScopeCataloger); ok {
		catalog, err := cataloger.ScopeCatalog(ctx, app)
		if err != nil {
			return nil, err
		}
		for _, scope := range named {
			if !slices.ContainsFunc(catalog.Scopes, func(c store.ExternalScopeChoice) bool { return c.ID == scope }) && !slices.Contains(always, scope) {
				return nil, fmt.Errorf("%w: %s is not in %s", ErrScopesUnsupported, scope, catalog.Source.Label)
			}
		}
	}
	return mergeScopes(always, named), nil
}

func mergeScopes(lists ...[]string) []string {
	merged := []string{}
	for _, list := range lists {
		for _, scope := range list {
			if scope = strings.TrimSpace(scope); scope != "" && !slices.Contains(merged, scope) {
				merged = append(merged, scope)
			}
		}
	}
	return merged
}

// Cloudflare's scopes are the authorization server's own list:
// scopes_supported of its OAuth metadata (RFC 8414) at
// https://mcp.cloudflare.com/.well-known/oauth-authorization-server.
// 403 scopes on 2026-11-06. A metadata read, no credential.
const cloudflareMetadataPath = "/.well-known/oauth-authorization-server"

type cloudflareScopes struct {
	mu      sync.Mutex
	scopes  []string
	fetched time.Time
}

const cloudflareScopesLifetime = time.Hour

func (c *Cloudflare) ScopeCatalog(ctx context.Context, _ *AppCredentials) (store.ExternalScopeCatalog, error) {
	c.catalog.mu.Lock()
	defer c.catalog.mu.Unlock()
	if c.catalog.scopes == nil || c.Now().Sub(c.catalog.fetched) > cloudflareScopesLifetime {
		scopes, err := c.fetchScopes(ctx)
		if err != nil && c.catalog.scopes == nil {
			return store.ExternalScopeCatalog{}, err
		}
		if err == nil {
			c.catalog.scopes, c.catalog.fetched = scopes, c.Now()
		}
	}
	always := c.Describe().AlwaysScopes
	preset := c.PresetScopes(false)
	catalog := store.ExternalScopeCatalog{
		Source:   store.ExternalScopeSource{Label: "Cloudflare OAuth metadata (scopes_supported)", URL: c.BaseURL + cloudflareMetadataPath, Complete: true},
		Always:   always,
		Replaces: true,
	}
	for _, scope := range c.catalog.scopes {
		if slices.Contains(always, scope) {
			continue
		}
		catalog.Scopes = append(catalog.Scopes, store.ExternalScopeChoice{ID: scope, Recommended: slices.Contains(preset, scope)})
	}
	return catalog, nil
}

func (c *Cloudflare) fetchScopes(ctx context.Context) ([]string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+cloudflareMetadataPath, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Foundry-Connector/1.0")
	response, err := c.Client.Do(request)
	if err != nil {
		return nil, errors.New("Cloudflare's scope list could not be read")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil || response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Cloudflare's scope list answered HTTP %d", response.StatusCode)
	}
	var metadata struct {
		Scopes []string `json:"scopes_supported"`
	}
	if json.Unmarshal(data, &metadata) != nil || len(metadata.Scopes) == 0 {
		return nil, errors.New("Cloudflare's OAuth metadata lists no scopes")
	}
	return metadata.Scopes, nil
}

// Feishu: a user login can only receive scopes its app holds, so the
// complete list for one app is the app's own, read with its tenant token
// from "查询租户授权状态" GET /open-apis/application/v6/scopes
// (open.feishu.cn/document/server-docs/application-v6/scope/list; no
// permission needed; grant_status 1 = granted to the app). Before an app
// exists only feishu-cli's preset is known, which is not complete.
const feishuAppScopesPath = "/open-apis/application/v6/scopes"

func (f *Feishu) ScopeCatalog(ctx context.Context, app *AppCredentials) (store.ExternalScopeCatalog, error) {
	recommended := FeishuPresetScopes(false)
	approval := feishuApprovalScopes()
	catalog := store.ExternalScopeCatalog{Source: store.ExternalScopeSource{Label: FeishuPresetSource()}, Always: append([]string(nil), feishuAlwaysScopes...)}
	held := map[string]bool{}
	if app != nil {
		token, _, err := f.TenantAccessToken(ctx, *app)
		if err != nil {
			return store.ExternalScopeCatalog{}, fmt.Errorf("read the app's scopes: %w", err)
		}
		raw, err := f.getJSON(ctx, openBase(app.BaseURL)+feishuAppScopesPath, token)
		if err != nil {
			return store.ExternalScopeCatalog{}, fmt.Errorf("read the app's scopes: %w", err)
		}
		data, _ := raw["data"].(map[string]any)
		entries, _ := data["scopes"].([]any)
		for _, entry := range entries {
			record, _ := entry.(map[string]any)
			if name := strings.TrimSpace(stringField(record, "scope_name")); name != "" {
				held[name] = held[name] || numberField(record, "grant_status", 0) == 1
			}
		}
		catalog.Source = store.ExternalScopeSource{
			Label:    "This app's scopes (Feishu application/v6/scopes)",
			URL:      "https://open.feishu.cn/document/server-docs/application-v6/scope/list",
			Complete: true,
		}
	}
	for _, scope := range mergeScopes(recommended, approval, sortedKeys(held)) {
		if slices.Contains(catalog.Always, scope) {
			continue
		}
		_, listed := held[scope]
		catalog.Scopes = append(catalog.Scopes, store.ExternalScopeChoice{
			ID:          scope,
			Recommended: slices.Contains(recommended, scope),
			Approval:    slices.Contains(approval, scope),
			Unavailable: app != nil && (!listed || !held[scope]),
		})
	}
	return catalog, nil
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
