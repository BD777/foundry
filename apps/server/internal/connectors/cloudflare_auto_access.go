package connectors

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	CloudflareEdgeAccessProvider = "cloudflare_access"
	CloudflareAutoProvisionEvent = "cloudflare_edge_access"
	maxCloudflareAutoPages       = 20
)

var (
	ErrCloudflareAccountNotConnected = errors.New("no usable Cloudflare account is connected for this person")
	ErrCloudflareAccountAmbiguous    = errors.New("more than one Cloudflare account is connected; choose the account before provisioning access")
	ErrCloudflareZeroTrustRequired   = errors.New("the Cloudflare connection is not authorized for Zero Trust")
	ErrCloudflareAutoProvisionInput  = errors.New("invalid Cloudflare edge access requirement")
)

// EdgeAccessMatch is the host and optional path prefix an EdgeAccess record
// protects. The secret store owns persistence; connectors only hand it the
// write-only credential.
type EdgeAccessMatch struct {
	Host       string `json:"host"`
	PathPrefix string `json:"pathPrefix,omitempty"`
}

// EdgeAccessCreateInput is the narrow credential handoff implemented by S1.
// ClientSecret is write-only and must never be copied into an API response,
// audit line, event or log.
type EdgeAccessCreateInput struct {
	Provider     string          `json:"provider"`
	Label        string          `json:"label"`
	Match        EdgeAccessMatch `json:"match"`
	Team         string          `json:"team,omitempty"`
	ClientID     string          `json:"clientId"`
	ClientSecret string          `json:"-"`
}

// EdgeAccessWriter is the only dependency on S1's EdgeAccess store.
type EdgeAccessWriter interface {
	CreateEdgeAccess(ctx context.Context, owner string, input EdgeAccessCreateInput) (id string, err error)
}

// CloudflareAutoProvisionInput is one edge_access_required record.
type CloudflareAutoProvisionInput struct {
	Owner    string `json:"owner"`
	Provider string `json:"provider"`
	Team     string `json:"team"`
	Host     string `json:"host"`
	Path     string `json:"path,omitempty"`
}

// EdgeAccessIngressSuggestion is a rule to review and add before the tunnel's
// catch-all rule. The service origin is intentionally a placeholder: Foundry
// does not infer where the application runs.
type EdgeAccessIngressSuggestion struct {
	Hostname string `json:"hostname"`
	Path     string `json:"path,omitempty"`
	Service  string `json:"service"`
	Note     string `json:"note"`
}

// CloudflareTunnelCheck is the read-only result of looking for a path in the
// account's remotely managed tunnels.
type CloudflareTunnelCheck struct {
	TunnelIDs        []string                     `json:"tunnelIds,omitempty"`
	NeedsIngress     bool                         `json:"needsIngress"`
	SuggestedIngress *EdgeAccessIngressSuggestion `json:"suggestedIngress,omitempty"`
}

// CloudflareAutoProvisionResult contains no credential or write-only value.
type CloudflareAutoProvisionResult struct {
	AccountID        string                `json:"accountId"`
	ServiceTokenName string                `json:"serviceTokenName"`
	ServiceTokenID   string                `json:"serviceTokenId"`
	ApplicationID    string                `json:"applicationId"`
	PolicyID         string                `json:"policyId"`
	EdgeAccessID     string                `json:"edgeAccessId"`
	Tunnel           CloudflareTunnelCheck `json:"tunnel"`
	RollbackComplete bool                  `json:"rollbackComplete,omitempty"`
}

type CloudflareAutoProvisionStore interface {
	ListExternalAccounts(ctx context.Context, userID string) ([]store.ExternalAccount, error)
	AppendExternalAccountEvent(ctx context.Context, event store.ExternalAccountEvent) error
}

type CloudflareAutoProvisionAPI interface {
	CloudflareRequest(ctx context.Context, account store.ExternalAccount, method, path string, query url.Values, body map[string]any, use externalaccounts.Use) (json.RawMessage, error)
}

// CloudflareAutoProvisioner creates the service token and self-hosted Access
// policy for an edge_access_required record, verifies tunnel ingress without
// changing it, then hands the token secret directly to EdgeAccessWriter.
type CloudflareAutoProvisioner struct {
	store  CloudflareAutoProvisionStore
	api    CloudflareAutoProvisionAPI
	edge   EdgeAccessWriter
	Now    func() time.Time
	Random func(int) (string, error)
}

func NewCloudflareAutoProvisioner(st CloudflareAutoProvisionStore, api CloudflareAutoProvisionAPI, edge EdgeAccessWriter) *CloudflareAutoProvisioner {
	if st == nil || api == nil || edge == nil {
		panic("NewCloudflareAutoProvisioner requires its store, Cloudflare API and EdgeAccessWriter")
	}
	return &CloudflareAutoProvisioner{store: st, api: api, edge: edge, Now: time.Now, Random: randomCloudflareID}
}

type cloudflareAutoAction struct {
	Input               CloudflareAutoProvisionInput
	AccountID           string
	CloudflareAccountID string
	ServiceToken        string
	ServiceTokenID      string
	ApplicationID       string
	PolicyID            string
	CreatedApp          bool
	CreatedPolicy       bool
	Committed           bool
}

type cloudflareAutoAudit struct {
	Owner          string `json:"owner"`
	Provider       string `json:"provider"`
	Team           string `json:"team,omitempty"`
	Host           string `json:"host"`
	Path           string `json:"path,omitempty"`
	ServiceToken   string `json:"serviceToken,omitempty"`
	ServiceTokenID string `json:"serviceTokenId,omitempty"`
	ApplicationID  string `json:"applicationId,omitempty"`
	PolicyID       string `json:"policyId,omitempty"`
	Result         string `json:"result"`
	NeedsIngress   bool   `json:"needsIngress,omitempty"`
	Error          string `json:"error,omitempty"`
}

type cloudflareAutoEnvelope struct {
	Success    *bool           `json:"success"`
	Result     json.RawMessage `json:"result"`
	ResultInfo struct {
		TotalCount int `json:"total_count"`
	} `json:"result_info"`
	Errors []externalaccounts.CloudflareAPIError `json:"errors"`
}

type cloudflareZeroTrustApplication struct {
	ID                string   `json:"id"`
	Domain            string   `json:"domain"`
	SelfHostedDomains []string `json:"self_hosted_domains"`
	Destinations      []struct {
		Type string `json:"type"`
		URI  string `json:"uri"`
	} `json:"destinations"`
}

type cloudflareZeroTrustTunnel struct {
	ID string `json:"id"`
}

func (p *CloudflareAutoProvisioner) Provision(ctx context.Context, input CloudflareAutoProvisionInput) (result CloudflareAutoProvisionResult, err error) {
	normalized, err := normalizeCloudflareAutoProvisionInput(input)
	if err != nil {
		return result, err
	}
	account, err := p.resolveAccount(ctx, normalized.Owner)
	if err != nil {
		return result, err
	}
	cloudflareAccountID, err := p.resolveCloudflareAccountID(ctx, account, normalized.Host)
	if err != nil {
		return result, err
	}
	action := &cloudflareAutoAction{Input: normalized, AccountID: account.ID, CloudflareAccountID: cloudflareAccountID}
	result.AccountID = cloudflareAccountID
	defer func() {
		if !action.Committed && action.ServiceTokenID != "" {
			rollbackErr := p.rollback(ctx, account, action)
			result.RollbackComplete = rollbackErr == nil
			if rollbackErr != nil {
				err = errors.Join(err, fmt.Errorf("roll back the Cloudflare Zero Trust writes: %w", rollbackErr))
			}
		}
		p.recordAutoProvision(ctx, account.ID, action, result, err)
	}()

	shortID, err := p.Random(6)
	if err != nil {
		return result, errors.New("create an Edge Access identifier")
	}
	action.ServiceToken = cloudflareServiceTokenName(normalized.Host, shortID)
	result.ServiceTokenName = action.ServiceToken
	var clientID, clientSecret string
	action.ServiceTokenID, clientID, clientSecret, err = p.createServiceToken(ctx, account, cloudflareAccountID, action.ServiceToken)
	if err != nil {
		return result, err
	}
	result.ServiceTokenID = action.ServiceTokenID

	action.ApplicationID, action.CreatedApp, err = p.ensureApplication(ctx, account, cloudflareAccountID, normalized.Host, normalized.Path, action.ServiceToken)
	if err != nil {
		return result, err
	}
	result.ApplicationID = action.ApplicationID
	action.PolicyID, err = p.createServiceAuthPolicy(ctx, account, cloudflareAccountID, action.ApplicationID, action.ServiceTokenID, shortID)
	if err != nil {
		return result, err
	}
	action.CreatedPolicy = true
	result.PolicyID = action.PolicyID

	result.Tunnel, err = p.checkTunnelIngress(ctx, account, cloudflareAccountID, normalized.Host, normalized.Path)
	if err != nil {
		return result, err
	}

	edgeID, err := p.edge.CreateEdgeAccess(context.WithoutCancel(ctx), normalized.Owner, EdgeAccessCreateInput{
		Provider: CloudflareEdgeAccessProvider,
		Label:    "Cloudflare Access for " + normalized.Host + normalized.Path,
		Match: EdgeAccessMatch{
			Host:       normalized.Host,
			PathPrefix: normalized.Path,
		},
		Team:         normalized.Team,
		ClientID:     clientID,
		ClientSecret: clientSecret,
	})
	if err != nil {
		return result, errors.New("could not store the Edge Access credential")
	}
	clientSecret = ""
	result.EdgeAccessID = edgeID
	action.Committed = true
	return result, nil
}

func normalizeCloudflareAutoProvisionInput(input CloudflareAutoProvisionInput) (CloudflareAutoProvisionInput, error) {
	input.Owner = strings.TrimSpace(input.Owner)
	input.Provider = strings.TrimSpace(input.Provider)
	input.Team = strings.TrimSpace(input.Team)
	if input.Owner == "" {
		return input, fmt.Errorf("%w: owner is required", ErrCloudflareAutoProvisionInput)
	}
	if input.Provider != CloudflareEdgeAccessProvider {
		return input, fmt.Errorf("%w: provider must be %s", ErrCloudflareAutoProvisionInput, CloudflareEdgeAccessProvider)
	}
	if input.Team == "" {
		return input, fmt.Errorf("%w: team is required", ErrCloudflareAutoProvisionInput)
	}
	host, err := normalizeCloudflareEdgeHost(input.Host)
	if err != nil {
		return input, fmt.Errorf("%w: %v", ErrCloudflareAutoProvisionInput, err)
	}
	pathPrefix, err := normalizeCloudflareEdgePath(input.Path)
	if err != nil {
		return input, fmt.Errorf("%w: %v", ErrCloudflareAutoProvisionInput, err)
	}
	input.Host, input.Path = host, pathPrefix
	return input, nil
}

func normalizeCloudflareEdgeHost(raw string) (string, error) {
	host := strings.ToLower(strings.TrimSpace(raw))
	if host == "" || strings.Contains(host, "://") || strings.ContainsAny(host, "*/?#@ \t\r\n") {
		return "", errors.New("host must be a hostname without a scheme, path, query, fragment, user or whitespace")
	}
	parsed, err := url.Parse("https://" + host)
	if err != nil || parsed.Host != host || parsed.Hostname() != host || parsed.Port() != "" || parsed.Path != "" {
		return "", errors.New("host must be a valid hostname without a port")
	}
	return host, nil
}

func normalizeCloudflareEdgePath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || value == "/" {
		return "", nil
	}
	if !strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\?#\x00\r\n") {
		return "", errors.New("path must be an absolute URL path without a query, fragment or backslash")
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." {
			return "", errors.New("path must not contain ..")
		}
	}
	clean := path.Clean(value)
	if clean == "/" {
		return "", nil
	}
	return clean, nil
}

func (p *CloudflareAutoProvisioner) resolveAccount(ctx context.Context, owner string) (store.ExternalAccount, error) {
	accounts, err := p.store.ListExternalAccounts(ctx, owner)
	if err != nil {
		return store.ExternalAccount{}, err
	}
	var usable []store.ExternalAccount
	for _, account := range accounts {
		if account.Provider != "cloudflare" {
			continue
		}
		switch account.Status {
		case store.ExternalAccountReady, store.ExternalAccountExpiring, "":
			usable = append(usable, account)
		}
	}
	switch len(usable) {
	case 0:
		return store.ExternalAccount{}, ErrCloudflareAccountNotConnected
	case 1:
		account := usable[0]
		level, _ := externalaccounts.CloudflareAccessLevel(externalaccounts.CloudflareAccessZeroTrust)
		if missing := externalaccounts.MissingScopes(level, account.GrantedScopes); len(missing) > 0 {
			return store.ExternalAccount{}, fmt.Errorf("%w: missing scopes: %s", ErrCloudflareZeroTrustRequired, strings.Join(missing, ", "))
		}
		return account, nil
	default:
		return store.ExternalAccount{}, ErrCloudflareAccountAmbiguous
	}
}

// resolveCloudflareAccountID finds the account that owns the host's zone.
// The person's OAuth identity can reach several Cloudflare accounts, while
// edge_access_required carries only the host. Exact host and parent-zone
// lookups keep the choice deterministic and refuse an ambiguous result.
func (p *CloudflareAutoProvisioner) resolveCloudflareAccountID(ctx context.Context, account store.ExternalAccount, host string) (string, error) {
	candidates := []string{}
	for name := host; name != ""; {
		raw, err := p.result(ctx, account, http.MethodGet, "/zones", url.Values{"name": {name}, "per_page": {"50"}}, nil)
		if err != nil {
			return "", err
		}
		var zones []struct {
			Name    string `json:"name"`
			Account struct {
				ID string `json:"id"`
			} `json:"account"`
		}
		if json.Unmarshal(raw, &zones) != nil {
			return "", errors.New("Cloudflare returned an unreadable zone list")
		}
		for _, zone := range zones {
			if (strings.EqualFold(zone.Name, host) || strings.HasSuffix(strings.ToLower(host), "."+strings.ToLower(zone.Name))) && cloudflareZoneID.MatchString(zone.Account.ID) {
				candidates = append(candidates, zone.Account.ID)
				name = ""
				break
			}
		}
		if name == "" {
			break
		}
		dot := strings.IndexByte(name, '.')
		if dot < 0 {
			break
		}
		name = name[dot+1:]
	}
	candidates = uniqueSortedStrings(candidates)
	switch len(candidates) {
	case 0:
		return "", errors.New("the host is not in a Cloudflare zone this identity can read")
	case 1:
		return candidates[0], nil
	default:
		return "", errors.New("the host matches zones in more than one Cloudflare account")
	}
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]bool{}
	for _, value := range values {
		if value != "" {
			seen[value] = true
		}
	}
	out := make([]string, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func (p *CloudflareAutoProvisioner) createServiceToken(ctx context.Context, account store.ExternalAccount, cloudflareAccountID, name string) (id, clientID, clientSecret string, err error) {
	raw, err := p.result(ctx, account, http.MethodPost, "/accounts/"+cloudflareAccountID+"/access/service_tokens", nil, map[string]any{"name": name})
	if err != nil {
		return "", "", "", err
	}
	var created struct {
		ID           string `json:"id"`
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if json.Unmarshal(raw, &created) != nil || !cloudflareOpaqueID.MatchString(created.ID) || created.ClientID == "" || created.ClientSecret == "" {
		return "", "", "", errors.New("Cloudflare returned an incomplete service token")
	}
	return created.ID, created.ClientID, created.ClientSecret, nil
}

func (p *CloudflareAutoProvisioner) ensureApplication(ctx context.Context, account store.ExternalAccount, cloudflareAccountID, host, pathPrefix, tokenName string) (id string, created bool, err error) {
	apps, err := p.listApplications(ctx, account, cloudflareAccountID)
	if err != nil {
		return "", false, err
	}
	if app := coveringCloudflareApplication(apps, host, pathPrefix); app != nil {
		return app.ID, false, nil
	}
	domain := host + pathPrefix
	raw, err := p.result(ctx, account, http.MethodPost, "/accounts/"+cloudflareAccountID+"/access/apps", nil, map[string]any{
		"name":   tokenName,
		"domain": domain,
		"type":   "self_hosted",
	})
	if err != nil {
		return "", false, err
	}
	var app struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &app) != nil || !cloudflareOpaqueID.MatchString(app.ID) {
		return "", false, errors.New("Cloudflare returned an incomplete Access application")
	}
	return app.ID, true, nil
}

func (p *CloudflareAutoProvisioner) createServiceAuthPolicy(ctx context.Context, account store.ExternalAccount, cloudflareAccountID, appID, tokenID, shortID string) (string, error) {
	raw, err := p.result(ctx, account, http.MethodPost, "/accounts/"+cloudflareAccountID+"/access/apps/"+appID+"/policies", nil, map[string]any{
		"name":     "foundry-" + shortID + "-service-auth",
		"decision": "non_identity",
		"include": []any{map[string]any{
			"service_token": map[string]any{"token_id": tokenID},
		}},
	})
	if err != nil {
		return "", err
	}
	var policy struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &policy) != nil || !cloudflareOpaqueID.MatchString(policy.ID) {
		return "", errors.New("Cloudflare returned an incomplete Access policy")
	}
	return policy.ID, nil
}

func (p *CloudflareAutoProvisioner) listApplications(ctx context.Context, account store.ExternalAccount, cloudflareAccountID string) ([]cloudflareZeroTrustApplication, error) {
	items, err := p.listAccountObjects(ctx, account, "/accounts/"+cloudflareAccountID+"/access/apps", url.Values{})
	if err != nil {
		return nil, err
	}
	apps := make([]cloudflareZeroTrustApplication, 0, len(items))
	for _, item := range items {
		var app cloudflareZeroTrustApplication
		if err := json.Unmarshal(item, &app); err != nil {
			return nil, errors.New("Cloudflare returned an unreadable Access application list")
		}
		apps = append(apps, app)
	}
	return apps, nil
}

func (p *CloudflareAutoProvisioner) listAccountObjects(ctx context.Context, account store.ExternalAccount, endpoint string, base url.Values) ([]json.RawMessage, error) {
	const perPage = 100
	all := []json.RawMessage{}
	for page := 1; page <= maxCloudflareAutoPages; page++ {
		query := cloneValues(base)
		query.Set("page", fmt.Sprint(page))
		query.Set("per_page", fmt.Sprint(perPage))
		envelope, err := p.envelope(ctx, account, http.MethodGet, endpoint, query, nil)
		if err != nil {
			return nil, err
		}
		var items []json.RawMessage
		if len(envelope.Result) > 0 && string(envelope.Result) != "null" {
			if err := json.Unmarshal(envelope.Result, &items); err != nil {
				return nil, errors.New("Cloudflare returned an unreadable list")
			}
		}
		all = append(all, items...)
		if len(items) < perPage || (envelope.ResultInfo.TotalCount > 0 && len(all) >= envelope.ResultInfo.TotalCount) {
			return all, nil
		}
	}
	return nil, errors.New("Cloudflare list exceeded the page limit")
}

func (p *CloudflareAutoProvisioner) checkTunnelIngress(ctx context.Context, account store.ExternalAccount, cloudflareAccountID, host, pathPrefix string) (CloudflareTunnelCheck, error) {
	items, err := p.listAccountObjects(ctx, account, "/accounts/"+cloudflareAccountID+"/cfd_tunnel", url.Values{"is_deleted": {"false"}})
	if err != nil {
		return CloudflareTunnelCheck{}, err
	}
	check := CloudflareTunnelCheck{}
	ids := map[string]bool{}
	for _, item := range items {
		var tunnel cloudflareZeroTrustTunnel
		if json.Unmarshal(item, &tunnel) != nil || !cloudflareOpaqueID.MatchString(tunnel.ID) {
			continue
		}
		ids[tunnel.ID] = true
		raw, err := p.result(ctx, account, http.MethodGet, "/accounts/"+cloudflareAccountID+"/cfd_tunnel/"+tunnel.ID+"/configurations", nil, nil)
		if err != nil {
			return CloudflareTunnelCheck{}, err
		}
		var configuration struct {
			Config struct {
				Ingress []struct {
					Hostname string `json:"hostname"`
					Path     string `json:"path"`
				} `json:"ingress"`
			} `json:"config"`
		}
		if json.Unmarshal(raw, &configuration) != nil {
			return CloudflareTunnelCheck{}, errors.New("Cloudflare returned an unreadable Tunnel configuration")
		}
		for _, ingress := range configuration.Config.Ingress {
			if strings.EqualFold(ingress.Hostname, host) && cloudflareIngressPathCovers(ingress.Path, pathPrefix) {
				return CloudflareTunnelCheck{}, nil
			}
		}
	}
	for id := range ids {
		check.TunnelIDs = append(check.TunnelIDs, id)
	}
	sort.Strings(check.TunnelIDs)
	check.NeedsIngress = true
	check.SuggestedIngress = &EdgeAccessIngressSuggestion{
		Hostname: host,
		Path:     pathPrefix,
		Service:  "http://<origin>",
		Note:     "Add this rule before the tunnel's catch-all rule. Foundry did not change the Tunnel.",
	}
	return check, nil
}

func cloudflareIngressPathCovers(pattern, target string) bool {
	pattern, target = strings.TrimSpace(pattern), strings.TrimSpace(target)
	if pattern == "" {
		return target == ""
	}
	if target == "" {
		return false
	}
	if strings.ContainsAny(pattern, `^$[](){}|+?\\`) {
		if re, err := regexp.Compile(pattern); err == nil {
			if match := re.FindStringIndex(target); match != nil && match[0] == 0 {
				return true
			}
		}
	}
	plain := strings.TrimSuffix(pattern, "*")
	if plain == target {
		return true
	}
	return strings.HasPrefix(target, strings.TrimSuffix(plain, "/")+"/")
}

func coveringCloudflareApplication(apps []cloudflareZeroTrustApplication, host, pathPrefix string) *cloudflareZeroTrustApplication {
	var best *cloudflareZeroTrustApplication
	bestLength := -1
	for i := range apps {
		for _, domain := range cloudflareApplicationDomains(apps[i]) {
			appHost, appPath, ok := cloudflareApplicationDomain(domain)
			if !ok || !strings.EqualFold(appHost, host) || !cloudflareAccessPathCovers(appPath, pathPrefix) {
				continue
			}
			if len(appPath) > bestLength {
				best, bestLength = &apps[i], len(appPath)
			}
		}
	}
	return best
}

func cloudflareApplicationDomains(app cloudflareZeroTrustApplication) []string {
	domains := []string{}
	if app.Domain != "" {
		domains = append(domains, app.Domain)
	}
	domains = append(domains, app.SelfHostedDomains...)
	for _, destination := range app.Destinations {
		if destination.URI != "" {
			domains = append(domains, destination.URI)
		}
	}
	return domains
}

func cloudflareApplicationDomain(raw string) (host, pathPrefix string, ok bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", "", false
	}
	value = strings.TrimPrefix(strings.TrimPrefix(value, "https://"), "http://")
	value = strings.TrimPrefix(value, "//")
	host, pathPrefix = value, ""
	if slash := strings.IndexByte(value, '/'); slash >= 0 {
		host, pathPrefix = value[:slash], value[slash:]
	}
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return "", "", false
	}
	pathPrefix = strings.TrimSuffix(strings.TrimSpace(pathPrefix), "*")
	return host, pathPrefix, true
}

func cloudflareAccessPathCovers(appPath, targetPath string) bool {
	appPath = strings.TrimSuffix(appPath, "*")
	if appPath == "" || appPath == "/" {
		return true
	}
	if targetPath == "" {
		return false
	}
	if appPath == targetPath {
		return true
	}
	return strings.HasPrefix(targetPath, strings.TrimSuffix(appPath, "/")+"/")
}

func cloudflareServiceTokenName(host, shortID string) string {
	if len(host) > 160 {
		host = host[:160]
	}
	return "foundry-" + host + "-" + shortID
}

func randomCloudflareID(bytes int) (string, error) {
	if bytes < 1 || bytes > 32 {
		return "", errors.New("invalid identifier length")
	}
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func cloneValues(input url.Values) url.Values {
	out := make(url.Values, len(input))
	for key, values := range input {
		out[key] = append([]string(nil), values...)
	}
	return out
}

func (p *CloudflareAutoProvisioner) result(ctx context.Context, account store.ExternalAccount, method, endpoint string, query url.Values, body map[string]any) (json.RawMessage, error) {
	envelope, err := p.envelope(ctx, account, method, endpoint, query, body)
	if err != nil {
		return nil, err
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return nil, errors.New("Cloudflare returned no result")
	}
	return envelope.Result, nil
}

func (p *CloudflareAutoProvisioner) envelope(ctx context.Context, account store.ExternalAccount, method, endpoint string, query url.Values, body map[string]any) (cloudflareAutoEnvelope, error) {
	use := externalaccounts.Use{By: "edge_access_auto"}
	raw, err := p.api.CloudflareRequest(ctx, account, method, endpoint, query, body, use)
	if err != nil {
		return cloudflareAutoEnvelope{}, err
	}
	var envelope cloudflareAutoEnvelope
	if json.Unmarshal(raw, &envelope) != nil {
		return cloudflareAutoEnvelope{}, errors.New("Cloudflare returned an unreadable API response")
	}
	if envelope.Success != nil && !*envelope.Success {
		message := "Cloudflare refused the API request"
		if len(envelope.Errors) > 0 {
			message += fmt.Sprintf(": %d: %s", envelope.Errors[0].Code, envelope.Errors[0].Message)
		}
		return cloudflareAutoEnvelope{}, errors.New(message)
	}
	return envelope, nil
}

func (p *CloudflareAutoProvisioner) rollback(ctx context.Context, account store.ExternalAccount, action *cloudflareAutoAction) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	var failures []error
	if action.CreatedPolicy && action.PolicyID != "" {
		if _, err := p.envelope(cleanupCtx, account, http.MethodDelete, "/accounts/"+action.CloudflareAccountID+"/access/apps/"+action.ApplicationID+"/policies/"+action.PolicyID, nil, nil); err != nil {
			failures = append(failures, err)
		}
	}
	if action.CreatedApp && action.ApplicationID != "" {
		if _, err := p.envelope(cleanupCtx, account, http.MethodDelete, "/accounts/"+action.CloudflareAccountID+"/access/apps/"+action.ApplicationID, nil, nil); err != nil {
			failures = append(failures, err)
		}
	}
	if action.ServiceTokenID != "" {
		if _, err := p.envelope(cleanupCtx, account, http.MethodDelete, "/accounts/"+action.CloudflareAccountID+"/access/service_tokens/"+action.ServiceTokenID, nil, nil); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (p *CloudflareAutoProvisioner) recordAutoProvision(ctx context.Context, accountID string, action *cloudflareAutoAction, result CloudflareAutoProvisionResult, actionErr error) {
	detail := cloudflareAutoAudit{
		Owner:          action.Input.Owner,
		Provider:       action.Input.Provider,
		Team:           action.Input.Team,
		Host:           action.Input.Host,
		Path:           action.Input.Path,
		ServiceToken:   action.ServiceToken,
		ServiceTokenID: action.ServiceTokenID,
		ApplicationID:  action.ApplicationID,
		PolicyID:       action.PolicyID,
		Result:         "succeeded",
		NeedsIngress:   result.Tunnel.NeedsIngress,
	}
	if actionErr != nil {
		detail.Result = "failed"
		detail.Error = shortError(actionErr)
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return
	}
	auditCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = p.store.AppendExternalAccountEvent(auditCtx, store.ExternalAccountEvent{
		AccountID: accountID,
		Kind:      CloudflareAutoProvisionEvent,
		ActorID:   action.Input.Owner,
		Detail:    string(raw),
	})
}
