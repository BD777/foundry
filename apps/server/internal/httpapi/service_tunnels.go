package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"golang.org/x/net/publicsuffix"
)

const serviceTunnelCapability = "service_tunnels_v1"

var serviceTunnelID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var serviceDNSLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

// serviceHostLabel is every allocated application label: a readable slug and
// 128 random bits. The suffix keeps service hosts disjoint from real names in
// the shared zone (dev, www, api, ...); ingress routes only this shape.
var serviceHostLabel = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,19}-[0-9a-f]{32}$`)

func tunnelRandom() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func (s *Server) tunnelStore() (store.ServiceTunnelStore, error) {
	t, ok := s.store.(store.ServiceTunnelStore)
	if !ok {
		return nil, errors.New("service mapping storage unavailable")
	}
	return t, nil
}

// PreviewDomain is a dedicated cookie site, never a child/sibling of the
// control plane, unless same-site mode was chosen. Same-site mode defaults to
// the control origin's registrable domain (dev.example.com -> example.com).
// PSL validation matters for domains such as example.co.uk.
func (s *Server) previewDomain() string {
	domain := strings.ToLower(strings.TrimSpace(s.options.PreviewDomain))
	control, err := url.Parse(s.options.AllowedOrigin)
	if err != nil || control.Scheme != "https" {
		return ""
	}
	if domain == "" && s.options.PreviewSameSite {
		domain, _ = publicsuffix.EffectiveTLDPlusOne(control.Hostname())
	}
	if domain == "" || strings.ContainsAny(domain, "/:@* ") {
		return ""
	}
	if len(domain) > 253 {
		return ""
	}
	for _, label := range strings.Split(domain, ".") {
		if !validServiceHostLabel(label) {
			return ""
		}
	}
	site, err := publicsuffix.EffectiveTLDPlusOne(domain)
	if err != nil {
		return ""
	}
	controlSite, err := publicsuffix.EffectiveTLDPlusOne(control.Hostname())
	if err != nil || (site == controlSite && !s.options.PreviewSameSite) {
		return ""
	}
	return domain
}
func (s *Server) tunnelURL(t store.ServiceTunnel) string {
	domain := s.previewDomain()
	if domain == "" || !s.previewRouted() {
		return ""
	}
	if s.options.PreviewSameSite && !serviceHostLabel.MatchString(t.HostLabel) {
		return ""
	}
	return "https://" + s.tunnelHostname(t)
}

func validServiceHostLabel(label string) bool {
	return len(label) <= 63 && serviceDNSLabel.MatchString(label)
}
func newServiceHostLabel(name string) string {
	slug := regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(name), "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 20 {
		slug = strings.TrimRight(slug[:20], "-")
	}
	if slug == "" {
		slug = "service"
	}
	return slug + "-" + tunnelRandom()[:32]
}
func (s *Server) tunnelHostname(t store.ServiceTunnel) string {
	if !s.options.PreviewSameSite {
		return t.ID + "." + s.previewDomain()
	}
	// First-level names only: Cloudflare Universal SSL covers *.<zone> but
	// not *.<sub>.<zone>. The mapping, not the hostname, records ownership.
	return t.HostLabel + "." + s.previewDomain()
}

func validTunnelPort(port int) bool {
	// HTTP ports only, with Foundry control/development ports always excluded.
	return port >= 1024 && port <= 65535 && port != 31982 && port != 31983 && !controlPorts[port]
}

// controlPorts are well-known loopback control planes (Docker API, Chrome
// DevTools, Node inspector, Kubernetes, Consul). Publishing one hands remote
// code execution on the device to everyone who can open it.
var controlPorts = map[int]bool{2375: true, 2376: true, 9222: true, 9229: true, 6443: true, 10250: true, 8500: true}

// authorizeTunnel is deliberately independent of device visibility. Sharing a
// workspace does not expose its owner's other local applications. Shared apps
// require Member because their HTTP interfaces may mutate business data.
func (s *Server) authorizeTunnel(ctx context.Context, t store.ServiceTunnel, userID string) bool {
	user, err := s.store.GetUser(ctx, userID)
	if err != nil || !user.Active() {
		return false
	}
	owner, err := s.store.DeviceOwner(ctx, t.DeviceID)
	if err != nil || owner != t.OwnerUserID {
		return false
	}
	workspace, err := s.store.GetWorkspace(ctx, t.TargetWorkspaceID)
	if err != nil || workspace.DeviceID != t.DeviceID {
		return false
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, userID)
	if err != nil || (!roleAtLeast(roles[t.WorkspaceID], store.WorkspaceRoleMember) || !roleAtLeast(roles[t.TargetWorkspaceID], store.WorkspaceRoleMember)) {
		return false
	}
	if userID != t.OwnerUserID && t.Visibility != "workspace" {
		return false
	}
	if t.WorkID != "" {
		backing, err := s.workStore()
		if err != nil {
			return false
		}
		items, err := backing.ListWorkspaceServices(ctx, t.WorkspaceID)
		if err != nil {
			return false
		}
		exists := false
		for _, item := range items {
			if item.ID == t.WorkID && item.DeviceID == t.DeviceID && item.DesiredState != "removed" {
				exists = true
			}
		}
		if !exists {
			return false
		}
	}
	return true
}
func (s *Server) liveTunnel(t store.ServiceTunnel) (*daemonConnection, string) {
	if !t.Enabled || !validTunnelPort(t.Port) {
		return nil, "disabled"
	}
	if s.previewDomain() == "" {
		return nil, "preview_domain_unconfigured"
	}
	if !s.previewRouted() {
		return nil, "preview_unrouted"
	}
	c := s.hub.connectionFor(t.DeviceID)
	if c == nil {
		return nil, "device_offline"
	}
	if !c.hasCapability(serviceTunnelCapability) {
		return nil, "worker_update_required"
	}
	return c, "ready"
}
func (s *Server) handleListServiceTunnels(w http.ResponseWriter, r *http.Request) {
	backing, err := s.tunnelStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items, err := backing.ListServiceTunnels(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	actor := actorFromContext(r.Context())
	rows := []store.ServiceTunnelView{}
	for _, item := range items {
		if s.authorizeTunnel(r.Context(), item, actor.AccountID()) {
			_, status := s.liveTunnel(item)
			target, _ := s.store.GetWorkspace(r.Context(), item.TargetWorkspaceID)
			rows = append(rows, store.ServiceTunnelView{ServiceTunnel: item, URL: s.tunnelURL(item), Status: status, CanManage: actor.AccountID() == item.OwnerUserID, DeviceLabel: target.DeviceLabel, TargetWorkspaceName: target.Name})
		}
	}
	targets := []store.WorkspaceProjection{}
	workspaces, err := s.store.ListWorkspaces(r.Context())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	scope, err := s.contextScope(r.Context(), actor)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, target := range workspaces {
		if scope.ownsDevice(target.DeviceID) && scope.can(target.ID, store.WorkspaceRoleMember) {
			targets = append(targets, target)
		}
	}
	var detected []store.DetectedService
	// The browser form adds services on this workspace's own device only; a
	// mapping to another device remains possible through the API.
	ownsDevice := false
	if workspace, err := s.store.GetWorkspace(r.Context(), r.PathValue("id")); err == nil {
		ownsDevice = actor.Kind == ActorAccount && scope.ownsDevice(workspace.DeviceID) && scope.can(workspace.ID, store.WorkspaceRoleMember)
		detected = s.observeServiceTunnels(r.Context(), workspace, rows, ownsDevice)
	}
	writeJSON(w, http.StatusOK, store.ServiceTunnelList{Items: rows, Detected: detected, CanManage: ownsDevice, Configured: s.previewDomain() != "", Routed: s.previewDomain() != "" && s.previewRouted(), Targets: targets})
}

type serviceTunnelInput = store.ServiceTunnelInput

func (s *Server) handleSaveServiceTunnel(w http.ResponseWriter, r *http.Request) {
	var input serviceTunnelInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	item, err := s.saveServiceTunnel(r.Context(), actorFromContext(r.Context()), r.PathValue("id"), r.PathValue("tunnelId"), input)
	writeResult(w, item, err)
}
func (s *Server) saveServiceTunnel(ctx context.Context, actor Actor, workspaceID, id string, input serviceTunnelInput) (store.ServiceTunnel, error) {
	var empty store.ServiceTunnel
	fail := func(status int, message string) (store.ServiceTunnel, error) {
		return empty, &statusError{status, errors.New(message)}
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return empty, err
	}
	userID := actor.AccountID()
	if actor.Agent() {
		userID = scope.agentFor
	}
	if userID == "" || scope.issueID != "" || !scope.can(workspaceID, store.WorkspaceRoleMember) {
		return fail(403, "workspace membership outside an Issue session required")
	}
	if input.TargetWorkspaceID == "" {
		input.TargetWorkspaceID = workspaceID
	}
	if !scope.can(input.TargetWorkspaceID, store.WorkspaceRoleMember) {
		return fail(403, "executing workspace membership required")
	}
	target, err := s.store.GetWorkspace(ctx, input.TargetWorkspaceID)
	if err != nil {
		return empty, err
	}
	owner, err := s.store.DeviceOwner(ctx, target.DeviceID)
	if err != nil || owner == "" || owner != userID {
		return fail(403, "only the executing device owner can register local service ports")
	}
	if actor.Kind != ActorAccount && input.Visibility != "private" {
		return fail(403, "sharing local services requires the person's explicit browser choice")
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 120 || !validTunnelPort(input.Port) || (input.Protocol != "" && input.Protocol != "http" && input.Protocol != "https") || (input.Visibility != "private" && input.Visibility != "workspace") || len(input.RegistrationKey) > 160 {
		return fail(400, "name, explicit HTTP(S) loopback port and private/workspace visibility required")
	}
	// A debugger endpoint the device can identify is refused whatever its port.
	// An empty protocol asks for detection: https when the port answers TLS.
	listeners, reported := s.workspaceListeners(ctx, target)
	for _, l := range listeners {
		if l.Port == input.Port && l.Debugger {
			return fail(400, "this port is a browser DevTools or Node inspector endpoint; publishing it would give remote code execution on the device")
		}
	}
	if input.Protocol == "" {
		input.Protocol = "http"
		for _, l := range listeners {
			if reported && l.Port == input.Port && l.TLS {
				input.Protocol = "https"
			}
		}
	}
	s.workMu.Lock()
	defer s.workMu.Unlock()
	backing, err := s.tunnelStore()
	if err != nil {
		return empty, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	item := store.ServiceTunnel{HostLabel: newServiceHostLabel(input.Name), ID: tunnelRandom()[:32], WorkspaceID: workspaceID, TargetWorkspaceID: target.ID, DeviceID: target.DeviceID, OwnerUserID: owner, WorkID: input.WorkID, Name: input.Name, Port: input.Port, Protocol: input.Protocol, Visibility: input.Visibility, Enabled: input.Enabled, Revision: 1, CreatedAt: now, UpdatedAt: now}
	if id != "" {
		previous, err := backing.GetServiceTunnel(ctx, id)
		if err != nil || previous.WorkspaceID != workspaceID || previous.OwnerUserID != owner {
			return fail(404, "service mapping not found")
		}
		// An explicit revision-checked update may relocate this application. The
		// new target/owner/workspace checks above still apply; invalidate below
		// closes every grant and stream tied to the previous deployment.
		if actor.Kind != ActorAccount && previous.Visibility != "private" {
			return fail(403, "shared mappings are managed from Foundry Web")
		}
		item.HostLabel = previous.HostLabel
		item.LastSeenAt = previous.LastSeenAt
		item.ID = previous.ID
		item.CreatedAt = previous.CreatedAt
		item.Revision = previous.Revision + 1
	} else if input.RegistrationKey != "" {
		// A retry of an agent's explicit registration cannot duplicate a service.
		item.ID = accounts.HashToken(userID + "\x00" + workspaceID + "\x00" + input.RegistrationKey)[:32]
		if previous, err := backing.GetServiceTunnel(ctx, item.ID); err == nil {
			if previous.Port != item.Port || previous.Protocol != item.Protocol || previous.TargetWorkspaceID != item.TargetWorkspaceID || previous.WorkID != item.WorkID {
				return fail(409, "registration key already names another service")
			}
			return previous, nil
		}
	}
	if !s.authorizeTunnel(ctx, item, owner) {
		return fail(403, "service must belong to these workspaces and the executing device")
	}
	if id == "" {
		items, err := backing.ListServiceTunnels(ctx, workspaceID)
		if err != nil {
			return empty, err
		}
		if len(items) >= 64 {
			return fail(409, "workspace service mapping limit reached")
		}
		err = backing.CreateServiceTunnel(ctx, item)
	} else {
		err = backing.UpdateServiceTunnel(ctx, item, input.ExpectedRevision)
	}
	if err != nil {
		return fail(409, err.Error())
	}
	s.tunnels.invalidate(item.ID)
	return item, nil
}

func (s *Server) handleDeleteServiceTunnel(w http.ResponseWriter, r *http.Request) {
	err := s.deleteServiceTunnel(r.Context(), actorFromContext(r.Context()), r.PathValue("id"), r.PathValue("tunnelId"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteServiceTunnel closes web access for good. Like disabling, it never
// touches the application process.
func (s *Server) deleteServiceTunnel(ctx context.Context, actor Actor, workspaceID, id string) error {
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return err
	}
	userID := actor.AccountID()
	if actor.Agent() {
		userID = scope.agentFor
	}
	if userID == "" || scope.issueID != "" || !scope.can(workspaceID, store.WorkspaceRoleMember) {
		return &statusError{403, errors.New("workspace membership outside an Issue session required")}
	}
	s.workMu.Lock()
	defer s.workMu.Unlock()
	backing, err := s.tunnelStore()
	if err != nil {
		return err
	}
	previous, err := backing.GetServiceTunnel(ctx, id)
	if err != nil || previous.WorkspaceID != workspaceID || previous.OwnerUserID != userID {
		return &statusError{404, errors.New("service mapping not found")}
	}
	if actor.Kind != ActorAccount && previous.Visibility != "private" {
		return &statusError{403, errors.New("shared mappings are managed from Foundry Web")}
	}
	if err := backing.DeleteServiceTunnel(ctx, id, workspaceID); err != nil {
		return err
	}
	s.tunnels.invalidate(id)
	return nil
}
