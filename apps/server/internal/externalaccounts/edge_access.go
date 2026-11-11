package externalaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

const (
	edgeAccessSecretVersion = 1
	edgeAccessTouchEvery    = time.Minute
	cloudflareAccessSuffix  = ".cloudflareaccess.com"
	edgeAccessClientIDHdr   = "Cf-Access-Client-Id"
	edgeAccessSecretHdr     = "Cf-Access-Client-Secret"
	edgeAccessErrorClass    = "edge_access_required"
)

var (
	ErrInvalidEdgeAccess     = errors.New("invalid edge access credential")
	ErrEdgeAccessUnsupported = errors.New("this server does not keep edge access credentials")
	edgeAccessHostPattern    = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
)

// EdgeAccessSecretID is the secret record holding a credential's client id and secret.
func EdgeAccessSecretID(id string) string { return "edge-access:" + id }

type edgeAccessSecretPayload struct {
	Version      int    `json:"version"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

func (s *Service) edgeAccessStore() (store.EdgeAccessStore, error) {
	st, ok := s.store.(store.EdgeAccessStore)
	if !ok {
		return nil, ErrEdgeAccessUnsupported
	}
	return st, nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeEdgeAccessInput(input store.EdgeAccessInput) (store.EdgeAccessInput, error) {
	input.Label = strings.TrimSpace(input.Label)
	input.Team = strings.ToLower(strings.TrimSpace(input.Team))
	input.Audience = strings.TrimSpace(input.Audience)
	input.ClientID = strings.TrimSpace(input.ClientID)
	input.ClientSecret = strings.TrimSpace(input.ClientSecret)
	input.Match.Host = strings.ToLower(strings.TrimSpace(input.Match.Host))
	prefix := strings.TrimSpace(input.Match.PathPrefix)
	if prefix != "" {
		if !strings.HasPrefix(prefix, "/") {
			return input, fmt.Errorf("%w: the path prefix must start with /", ErrInvalidEdgeAccess)
		}
		prefix = strings.TrimRight(prefix, "/")
	}
	input.Match.PathPrefix = prefix
	switch {
	case input.Label == "" || len(input.Label) > 120:
		return input, fmt.Errorf("%w: a label of up to 120 characters is required", ErrInvalidEdgeAccess)
	case input.Provider != store.EdgeAccessProviderCloudflareAccess:
		return input, fmt.Errorf("%w: only the cloudflare_access provider is supported", ErrInvalidEdgeAccess)
	case !edgeAccessHostPattern.MatchString(input.Match.Host) || len(input.Match.Host) > 253:
		return input, fmt.Errorf("%w: the host must be a bare host name without scheme, port or path", ErrInvalidEdgeAccess)
	}
	return input, nil
}

func (s *Service) ListEdgeAccess(ctx context.Context, ownerUserID string) (store.EdgeAccessList, error) {
	st, err := s.edgeAccessStore()
	if err != nil {
		return store.EdgeAccessList{}, err
	}
	items, err := st.ListEdgeAccess(ctx, ownerUserID)
	if err != nil {
		return store.EdgeAccessList{}, err
	}
	return store.EdgeAccessList{Credentials: jsonempty.List[store.EdgeAccess](items)}, nil
}

func (s *Service) CreateEdgeAccess(ctx context.Context, ownerUserID string, input store.EdgeAccessInput) (store.EdgeAccess, error) {
	st, err := s.edgeAccessStore()
	if err != nil {
		return store.EdgeAccess{}, err
	}
	input, err = normalizeEdgeAccessInput(input)
	if err != nil {
		return store.EdgeAccess{}, err
	}
	if input.ClientID == "" || input.ClientSecret == "" {
		return store.EdgeAccess{}, fmt.Errorf("%w: the client id and client secret are required", ErrInvalidEdgeAccess)
	}
	if s.secrets == nil {
		return store.EdgeAccess{}, ErrSecretsNotConfigured
	}
	stamp := s.now().Format(time.RFC3339)
	item := store.EdgeAccess{
		ID: "edge_" + uuid.NewString(), Label: input.Label, Provider: input.Provider, Match: input.Match,
		Team: input.Team, Audience: input.Audience, CreatedAt: stamp, UpdatedAt: stamp,
	}
	if err := s.sealEdgeAccess(ctx, item.ID, input.ClientID, input.ClientSecret); err != nil {
		return store.EdgeAccess{}, err
	}
	if err := st.SaveEdgeAccess(ctx, ownerUserID, item); err != nil {
		_ = s.secrets.DeleteSecret(ctx, EdgeAccessSecretID(item.ID))
		return store.EdgeAccess{}, err
	}
	return item, nil
}

// ReplaceEdgeAccess updates a credential; an empty client id or secret keeps the sealed one.
func (s *Service) ReplaceEdgeAccess(ctx context.Context, ownerUserID, id string, input store.EdgeAccessInput) (store.EdgeAccess, error) {
	st, err := s.edgeAccessStore()
	if err != nil {
		return store.EdgeAccess{}, err
	}
	input, err = normalizeEdgeAccessInput(input)
	if err != nil {
		return store.EdgeAccess{}, err
	}
	existing, err := st.GetEdgeAccess(ctx, ownerUserID, id)
	if err != nil {
		return store.EdgeAccess{}, err
	}
	if s.secrets == nil {
		return store.EdgeAccess{}, ErrSecretsNotConfigured
	}
	if input.ClientID != "" || input.ClientSecret != "" {
		clientID, clientSecret := input.ClientID, input.ClientSecret
		if clientID == "" || clientSecret == "" {
			current, err := s.openEdgeAccess(ctx, id)
			if err != nil {
				return store.EdgeAccess{}, err
			}
			if clientID == "" {
				clientID = current.ClientID
			}
			if clientSecret == "" {
				clientSecret = current.ClientSecret
			}
		}
		if err := s.sealEdgeAccess(ctx, id, clientID, clientSecret); err != nil {
			return store.EdgeAccess{}, err
		}
	}
	existing.Label, existing.Provider, existing.Match = input.Label, input.Provider, input.Match
	existing.Team, existing.Audience = input.Team, input.Audience
	existing.UpdatedAt = s.now().Format(time.RFC3339)
	if err := st.SaveEdgeAccess(ctx, ownerUserID, existing); err != nil {
		return store.EdgeAccess{}, err
	}
	return existing, nil
}

func (s *Service) DeleteEdgeAccess(ctx context.Context, ownerUserID, id string) error {
	st, err := s.edgeAccessStore()
	if err != nil {
		return err
	}
	if err := st.DeleteEdgeAccess(ctx, ownerUserID, id); err != nil {
		return err
	}
	if s.secrets != nil {
		if err := s.secrets.DeleteSecret(ctx, EdgeAccessSecretID(id)); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	return nil
}

func (s *Service) sealEdgeAccess(ctx context.Context, id, clientID, clientSecret string) error {
	payload, err := json.Marshal(edgeAccessSecretPayload{Version: edgeAccessSecretVersion, ClientID: clientID, ClientSecret: clientSecret})
	if err != nil {
		return err
	}
	return s.secrets.PutSecret(ctx, EdgeAccessSecretID(id), payload, EdgeAccessSecretID(id))
}

func (s *Service) openEdgeAccess(ctx context.Context, id string) (edgeAccessSecretPayload, error) {
	if s.secrets == nil {
		return edgeAccessSecretPayload{}, ErrSecretsNotConfigured
	}
	raw, err := s.secrets.GetSecret(ctx, EdgeAccessSecretID(id))
	if err != nil {
		return edgeAccessSecretPayload{}, fmt.Errorf("the sealed edge access credential is unavailable: %w", err)
	}
	var payload edgeAccessSecretPayload
	if json.Unmarshal(raw, &payload) != nil || payload.Version != edgeAccessSecretVersion {
		return edgeAccessSecretPayload{}, errors.New("the sealed edge access credential is unreadable")
	}
	return payload, nil
}

// MatchEdgeAccess picks the credential for an upstream URL: the host matches
// exactly (case-insensitive, port ignored) and the longest path prefix wins.
func MatchEdgeAccess(items []store.EdgeAccess, target *url.URL) (store.EdgeAccess, bool) {
	host := strings.ToLower(target.Hostname())
	path := target.EscapedPath()
	if path == "" {
		path = "/"
	}
	candidates := make([]store.EdgeAccess, 0, len(items))
	for _, item := range items {
		if strings.ToLower(item.Match.Host) != host {
			continue
		}
		prefix := strings.TrimRight(item.Match.PathPrefix, "/")
		if prefix == "" || path == prefix || strings.HasPrefix(path, prefix+"/") {
			candidates = append(candidates, item)
		}
	}
	if len(candidates) == 0 {
		return store.EdgeAccess{}, false
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return len(candidates[i].Match.PathPrefix) > len(candidates[j].Match.PathPrefix)
	})
	return candidates[0], true
}

// edgeAttachment records what one upstream request carried, so its outcome can
// be read against it and its secrets kept out of any error text.
type edgeAttachment struct {
	matched *store.EdgeAccess
	secrets []string
}

// attachEdgeAccess sets the matching credential's headers on the request. The
// values live only in this request's memory (and, for a device path, the one
// request handed to the device). Any client-supplied Cf-Access headers are
// dropped first so the stored credential is the only source.
func (s *Service) attachEdgeAccess(ctx context.Context, ownerUserID string, request *http.Request) (edgeAttachment, error) {
	request.Header.Del(edgeAccessClientIDHdr)
	request.Header.Del(edgeAccessSecretHdr)
	st, ok := s.store.(store.EdgeAccessStore)
	if !ok || ownerUserID == "" {
		return edgeAttachment{}, nil
	}
	items, err := st.ListEdgeAccess(ctx, ownerUserID)
	if err != nil {
		return edgeAttachment{}, err
	}
	item, ok := MatchEdgeAccess(items, request.URL)
	if !ok {
		return edgeAttachment{}, nil
	}
	credential, err := s.openEdgeAccess(ctx, item.ID)
	if err != nil {
		return edgeAttachment{}, err
	}
	request.Header.Set(edgeAccessClientIDHdr, credential.ClientID)
	request.Header.Set(edgeAccessSecretHdr, credential.ClientSecret)
	if last, err := time.Parse(time.RFC3339, item.LastUsedAt); err != nil || s.now().Sub(last) >= edgeAccessTouchEvery {
		_ = st.TouchEdgeAccess(ctx, ownerUserID, item.ID, s.now().Format(time.RFC3339))
	}
	return edgeAttachment{matched: &item, secrets: []string{credential.ClientID, credential.ClientSecret}}, nil
}

func (a edgeAttachment) redact(secrets map[string]string) map[string]string {
	if len(a.secrets) == 0 {
		return secrets
	}
	merged := make(map[string]string, len(secrets)+len(a.secrets))
	for key, value := range secrets {
		merged[key] = value
	}
	for index, value := range a.secrets {
		merged[fmt.Sprintf("edge-access-%d", index)] = value
	}
	return merged
}

// failure reads a transport error: a refused redirect into Cloudflare Access
// becomes edge_access_required, anything else keeps its own class.
func (a edgeAttachment) failure(err error, request *http.Request) error {
	var redirect *extensionRedirectError
	if errors.As(err, &redirect) && redirect.target != nil {
		if team, ok := cloudflareAccessTeam(redirect.target.Hostname()); ok {
			return a.required(team, request)
		}
	}
	return classifyExtensionTransportError(err)
}

// inspect reads a response (device paths hand redirects back as responses):
// a 3xx into <team>.cloudflareaccess.com, or a 3xx/401/403 carrying
// Cf-Access-* headers or a CF_Authorization cookie, is edge_access_required.
func (a edgeAttachment) inspect(response *http.Response, request *http.Request) *ExtensionProbeError {
	status := response.StatusCode
	if status < 300 || (status >= 400 && status != http.StatusUnauthorized && status != http.StatusForbidden) {
		return nil
	}
	if status < 400 {
		if location, err := request.URL.Parse(response.Header.Get("Location")); err == nil {
			if team, ok := cloudflareAccessTeam(location.Hostname()); ok {
				return a.required(team, request)
			}
		}
	}
	for name := range response.Header {
		if strings.HasPrefix(http.CanonicalHeaderKey(name), "Cf-Access-") {
			return a.required("", request)
		}
	}
	for _, cookie := range response.Header.Values("Set-Cookie") {
		if strings.Contains(cookie, "CF_Authorization") {
			return a.required("", request)
		}
	}
	return nil
}

func cloudflareAccessTeam(host string) (string, bool) {
	host = strings.ToLower(host)
	if !strings.HasSuffix(host, cloudflareAccessSuffix) {
		return "", false
	}
	team := strings.TrimSuffix(host, cloudflareAccessSuffix)
	return team, team != "" && !strings.Contains(team, ".")
}

func (a edgeAttachment) required(team string, request *http.Request) *ExtensionProbeError {
	address := request.URL.Hostname() + request.URL.EscapedPath()
	behind := "Cloudflare Access"
	if team != "" {
		behind += " (team " + team + ")"
	}
	required := store.EdgeAccessRequired{
		Provider: store.EdgeAccessProviderCloudflareAccess, Team: team,
		Host: strings.ToLower(request.URL.Hostname()), Path: request.URL.EscapedPath(),
	}
	if a.matched != nil {
		required.CredentialID = a.matched.ID
		required.Message = fmt.Sprintf("%s rejected the stored edge access credential %q for %s. Replace it in Settings → Edge access, or ask Foundry to provision a new service token.", behind, a.matched.Label, address)
	} else {
		required.Message = fmt.Sprintf("%s is in front of %s and needs an edge access credential. Add one in Settings → Edge access, or ask Foundry to provision a service token (needs the Cloudflare connector's Zero Trust authorization).", address, behind)
	}
	return &ExtensionProbeError{Class: edgeAccessErrorClass, Message: required.Message, EdgeAccess: &required}
}
