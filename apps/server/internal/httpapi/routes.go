package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// accessRule decides whether an authenticated request may reach a handler.
// Every API route declares exactly one; the coverage test fails on a route
// without one. check writes the refusal itself and returns false.
type accessRule struct {
	kind  string
	check func(s *Server, w http.ResponseWriter, r *http.Request) bool
}

// Rule kinds that delegate the decision to the handler, because the target
// is only known from the body, the result is filtered per caller, or the
// route is the daemon protocol. Tests assert each one individually.
const (
	ruleInHandler = "in-handler"
	ruleFiltered  = "filtered"
	ruleDaemon    = "daemon"
)

var allow = func(*Server, http.ResponseWriter, *http.Request) bool { return true }

func publicRoute() accessRule { return accessRule{kind: "public", check: allow} }

// signedIn routes serve the caller's own account (profile, pairing tokens).
func signedIn() accessRule { return accessRule{kind: "signed-in", check: allow} }

// personOnly routes act for the signed-in person on their own assistant: a
// device credential or a session token never reaches them, so neither can
// accept a proposal or change a setting (docs/personal-agent.md §4).
func personOnly() accessRule {
	return accessRule{kind: "person", check: func(_ *Server, w http.ResponseWriter, r *http.Request) bool {
		if actor := actorFromContext(r.Context()); actor.Kind != ActorAccount || actor.AccountID() == "" {
			writeForbidden(w, "Only the signed-in person manages their assistant.")
			return false
		}
		return true
	}}
}

func inHandler() accessRule { return accessRule{kind: ruleInHandler, check: allow} }
func filtered() accessRule  { return accessRule{kind: ruleFiltered, check: allow} }
func daemonProtocol() accessRule {
	return accessRule{kind: ruleDaemon, check: func(_ *Server, w http.ResponseWriter, r *http.Request) bool {
		if actorFromContext(r.Context()).Kind != ActorDaemon {
			writeError(w, http.StatusUnauthorized, "device credential required")
			return false
		}
		return true
	}}
}

// adminOnly manages the instance: accounts, invites, the global skill
// catalog and dev reset.
func adminOnly() accessRule {
	return accessRule{kind: "admin", check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		scope, err := s.requestScope(r)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "resolve access")
			return false
		}
		if !scope.admin {
			writeForbidden(w, "This action needs the instance Admin role.")
			return false
		}
		return true
	}}
}

// workspaceResolver finds the workspace a request targets; store.ErrNotFound
// means the referenced record does not exist.
type workspaceResolver func(s *Server, r *http.Request) (string, error)

func workspaceRole(need string, resolve workspaceResolver) accessRule {
	return accessRule{kind: "workspace:" + need, check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		workspaceID, err := resolve(s, r)
		if errors.Is(err, errWorkspaceRequired) {
			// Package-test servers list across workspaces.
			if scope, scopeErr := s.requestScope(r); scopeErr == nil && scope.all {
				return true
			}
			writeError(w, http.StatusBadRequest, "workspaceId is required")
			return false
		}
		if err != nil || workspaceID == "" {
			writeError(w, http.StatusNotFound, "not found")
			return false
		}
		return s.requireWorkspace(w, r, workspaceID, need)
	}}
}

var errWorkspaceRequired = errors.New("workspaceId is required")

// workspaceRoleOrDeletedFromDevice is workspaceRole, except that a device may
// read a workspace the person deleted from it while it stays deleted, which
// holds nothing. Workers up to 0.5.7-dev.12 read the Issues of the folder
// their service names on every start, deleted or not, and exit when that
// read fails; until deletions were remembered, the deleted workspace coming
// back on the same start hid this.
func workspaceRoleOrDeletedFromDevice(need string, resolve workspaceResolver) accessRule {
	rule := workspaceRole(need, resolve)
	return accessRule{kind: rule.kind + "|deleted-from-device", check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		return s.deletedFromRequestingDevice(r, resolve) || rule.check(s, w, r)
	}}
}

func (s *Server) deletedFromRequestingDevice(r *http.Request, resolve workspaceResolver) bool {
	actor := actorFromContext(r.Context())
	if actor.Kind != ActorDaemon || actor.DeviceID == "" {
		return false
	}
	workspaceID, err := resolve(s, r)
	if err != nil || workspaceID == "" {
		return false
	}
	if _, err := s.store.GetWorkspace(r.Context(), workspaceID); !errors.Is(err, store.ErrNotFound) {
		return false
	}
	deleted, err := s.store.WorkspaceDeletedFromDevice(r.Context(), workspaceID, actor.DeviceID)
	return err == nil && deleted
}

// issueCreatorOr lets the Issue's creator act with Member access and everyone
// else only with `need` (confirming the contract and verifying one's own
// Issue, §2.1).
func issueCreatorOr(need string) accessRule {
	return accessRule{kind: "workspace:" + need + "|creator:member", check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
		if err != nil || issue.WorkspaceID == "" {
			writeError(w, http.StatusNotFound, "not found")
			return false
		}
		scope, err := s.requestScope(r)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "resolve access")
			return false
		}
		role := need
		if scope.userID != "" && scope.userID == issue.CreatedByUserID {
			role = store.WorkspaceRoleMember
		}
		return s.requireWorkspace(w, r, issue.WorkspaceID, role)
	}}
}

func pathWorkspace(name string) workspaceResolver {
	return func(_ *Server, r *http.Request) (string, error) {
		return strings.TrimSpace(r.PathValue(name)), nil
	}
}

// queryWorkspace reads ?workspaceId=; an agent defaults to its own workspace.
func queryWorkspace() workspaceResolver {
	return func(_ *Server, r *http.Request) (string, error) {
		if workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId")); workspaceID != "" {
			return workspaceID, nil
		}
		if actor := actorFromContext(r.Context()); actor.Agent() {
			return actor.Identity.WorkspaceID, nil
		}
		return "", errWorkspaceRequired
	}
}

func issueWorkspace(name string) workspaceResolver {
	return func(s *Server, r *http.Request) (string, error) {
		issue, err := s.store.GetIssue(r.Context(), r.PathValue(name))
		return issue.WorkspaceID, err
	}
}

func sessionWorkspace(name string) workspaceResolver {
	return func(s *Server, r *http.Request) (string, error) {
		session, err := s.store.GetAgentSessionSummary(r.Context(), r.PathValue(name))
		if err == nil {
			guardedRecordsFrom(r).session = session
		}
		return session.WorkspaceID, err
	}
}

// guardedRecords carries a record a route's access check read to the
// route's handler, so the handler does not read it again.
type guardedRecords struct {
	session store.AgentSession
}

type guardedRecordsKey struct{}

// guardedRecordsFrom is the holder guard puts in every request it checks.
func guardedRecordsFrom(r *http.Request) *guardedRecords {
	return r.Context().Value(guardedRecordsKey{}).(*guardedRecords)
}

// guardedSession is the session (its summary) the route's access check read
// and allowed: routes guarded by sessionWorkspace hand it to their handlers,
// which neither read it again nor check that the caller may read it.
// chatOrSessionWorkspace hands it over when the id is a session's; for a
// native chat it is the zero session.
func guardedSession(r *http.Request) store.AgentSession {
	return guardedRecordsFrom(r).session
}

// chatOrSessionWorkspace resolves a chat-list id: a native chat, or a
// Foundry session (sess_…), whose title the chat list also renames.
func chatOrSessionWorkspace(name string) workspaceResolver {
	return func(s *Server, r *http.Request) (string, error) {
		chat, err := s.store.GetChat(r.Context(), r.PathValue(name))
		if !errors.Is(err, store.ErrNotFound) {
			return chat.WorkspaceID, err
		}
		return sessionWorkspace(name)(s, r)
	}
}

func chatWorkspace(name string) workspaceResolver {
	return func(s *Server, r *http.Request) (string, error) {
		chat, err := s.store.GetChat(r.Context(), r.PathValue(name))
		return chat.WorkspaceID, err
	}
}

// deviceOwner guards device management. Devices paired before device
// credentials have no owner; an admin may still remove those.
func deviceOwner(name string) accessRule {
	return accessRule{kind: "device-owner", check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		return s.requireDeviceOwner(w, r, strings.TrimSpace(r.PathValue(name)))
	}}
}

func deviceRemovalOwner(name string) accessRule {
	return accessRule{kind: "device-owner", check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		return s.requireDeviceHistoricalOwner(w, r, strings.TrimSpace(r.PathValue(name)))
	}}
}

func (s *Server) requireDeviceOwner(w http.ResponseWriter, r *http.Request, deviceID string) bool {
	if !s.requireDeviceHistoricalOwner(w, r, deviceID) {
		return false
	}
	if err := store.RequireDeviceAvailable(r.Context(), s.store, deviceID); err != nil {
		writeResult(w, nil, err)
		return false
	}
	return true
}

func (s *Server) requireDeviceHistoricalOwner(w http.ResponseWriter, r *http.Request, deviceID string) bool {
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return false
	}
	if scope.ownsDevice(deviceID) {
		return true
	}
	if scope.admin && deviceID != "" {
		if owner, err := s.deviceOwnerOf(r, deviceID); err == nil && owner == "" {
			return true
		}
	}
	writeError(w, http.StatusNotFound, "device not found")
	return false
}

func (s *Server) deviceOwnerOf(r *http.Request, deviceID string) (string, error) {
	return s.store.DeviceOwner(r.Context(), deviceID)
}

// connectionOwner guards a server connection (profile) by its owner.
func connectionOwner(name string) accessRule {
	return accessRule{kind: "connection-owner", check: func(s *Server, w http.ResponseWriter, r *http.Request) bool {
		return s.requireConnectionOwner(w, r, strings.TrimSpace(r.PathValue(name)))
	}}
}

func (s *Server) requireConnectionOwner(w http.ResponseWriter, r *http.Request, profileID string) bool {
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return false
	}
	profile, err := s.store.GetProfile(r.Context(), profileID)
	if err != nil || scope.userID == "" || profile.OwnerUserID != scope.userID {
		writeError(w, http.StatusNotFound, "connection not found")
		return false
	}
	return true
}

type route struct {
	pattern string
	handler http.Handler
	rule    accessRule
}

func (s *Server) routeTable() []route {
	viewer, member, maintainer, owner := store.WorkspaceRoleViewer, store.WorkspaceRoleMember,
		store.WorkspaceRoleMaintainer, store.WorkspaceRoleOwner
	fn := func(pattern string, handler http.HandlerFunc, rule accessRule) route {
		return route{pattern: pattern, handler: handler, rule: rule}
	}
	routes := []route{
		// Session event stream: each subscriber only receives its workspaces.
		fn("GET /api/events", s.handleEvents, filtered()),
		fn("POST /api/mcp", s.handleMCP, inHandler()),

		fn("GET /api/auth/state", s.handleAuthState, publicRoute()),
		fn("POST /api/auth/setup", s.handleAuthSetup, publicRoute()),
		fn("POST /api/auth/login", s.handleAuthLogin, publicRoute()),
		fn("POST /api/auth/logout", s.handleAuthLogout, publicRoute()),
		fn("PATCH /api/auth/me", s.handleUpdateMe, signedIn()),
		fn("POST /api/auth/me/password", s.handleChangePassword, signedIn()),
		fn("GET /api/auth/invites/{token}", s.handleGetInvite, publicRoute()),
		fn("POST /api/auth/invites/{token}/accept", s.handleAcceptInvite, publicRoute()),
		fn("GET /api/users", s.handleListUsers, adminOnly()),
		fn("PATCH /api/users/{id}", s.handleUpdateUser, adminOnly()),
		fn("GET /api/invites", s.handleListInvites, adminOnly()),
		fn("POST /api/invites", s.handleCreateInvite, adminOnly()),
		fn("DELETE /api/invites/{id}", s.handleRevokeInvite, adminOnly()),

		fn("GET /api/foundry-data", s.handleFoundryData, filtered()),
		fn("GET /api/workspaces", s.handleListWorkspaces, filtered()),
		// The target device comes from the body.
		fn("POST /api/workspaces", s.handleCreateWorkspace, inHandler()),
		fn("POST /api/workspaces/subdirectories", s.handleListWorkspaceSubdirectories, inHandler()),
		fn("GET /api/workspaces/{id}", s.handleGetWorkspace, workspaceRole(viewer, pathWorkspace("id"))),
		fn("PATCH /api/workspaces/{id}", s.handleRenameWorkspace, workspaceRole(owner, pathWorkspace("id"))),
		fn("DELETE /api/workspaces/{id}", s.handleDeleteWorkspace, workspaceRole(owner, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/relink", s.handleRelinkWorkspace, workspaceRole(owner, pathWorkspace("id"))),
		fn("GET /api/workspaces/{id}/relink-suggestions", s.handleWorkspaceRelinkSuggestions, workspaceRole(owner, pathWorkspace("id"))),
		fn("GET /api/workspaces/{id}/feishu", s.handleGetWorkspaceFeishuBot, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/feishu", s.handleSaveWorkspaceFeishuBot, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/feishu/pair-code", s.handleGenerateFeishuPairingCode, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("DELETE /api/workspaces/{id}/feishu/chats/{routeId}", s.handleUnbindFeishuChat, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/feishu/chats/{routeId}/refresh-name", s.handleRefreshFeishuChatName, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("DELETE /api/workspaces/{id}/feishu", s.handleDeleteWorkspaceFeishuBot, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("GET /api/feishu/app-uses", s.handleFeishuAppUses, inHandler()),
		// Default agents (agent_defaults.go): anyone in the workspace reads
		// what a new chat runs as; maintainers set them.
		fn("GET /api/workspaces/{id}/agent-defaults", s.handleGetAgentDefaults, workspaceRole(viewer, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/agent-defaults", s.handleSetAgentDefault, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("GET /api/workspaces/{id}/members", s.handleListWorkspaceMembers, workspaceRole(viewer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/members", s.handleAddWorkspaceMember, workspaceRole(owner, pathWorkspace("id"))),
		fn("PATCH /api/workspaces/{id}/members/{userId}", s.handleUpdateWorkspaceMember, workspaceRole(owner, pathWorkspace("id"))),
		// Owners remove anyone; any member may leave (in handler).
		fn("DELETE /api/workspaces/{id}/members/{userId}", s.handleRemoveWorkspaceMember, inHandler()),
		fn("GET /api/workspaces/{id}/draft-skills", s.handleWorkspaceDraftSkills, workspaceRole(viewer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/draft-skills/refresh", s.handleWorkspaceDraftSkills, workspaceRole(member, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/draft-skills", s.handleSetWorkspaceDraftSkills, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("GET /api/workspaces/{id}/skills", s.handleListWorkspaceSkills, workspaceRole(viewer, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/skills", s.handleSetWorkspaceSkills, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/skills/{skillId}/pin", s.handleSetWorkspaceSkillPin, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("GET /api/me/default-skills", s.handleListMyDefaultSkills, signedIn()),
		fn("PUT /api/me/default-skills", s.handleSetMyDefaultSkills, signedIn()),
		fn("GET /api/workspaces/{id}/service-tunnels", s.handleListServiceTunnels, workspaceRole(viewer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/service-tunnels", s.handleSaveServiceTunnel, workspaceRole(member, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/service-tunnels/{tunnelId}", s.handleSaveServiceTunnel, workspaceRole(member, pathWorkspace("id"))),
		fn("GET /api/service-tunnels/{tunnelId}/authorize", s.handleAuthorizeServiceTunnel, inHandler()),
		fn("GET /api/daemon/service-tunnels/{streamId}", s.handleServiceTunnelStream, inHandler()),
		fn("GET /api/workspaces/{id}/services", s.handleWorkspaceServices, workspaceRole(viewer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/services/{workId}/operations", s.handleWorkspaceServiceControl, workspaceRole(member, pathWorkspace("id"))),
		fn("GET /api/workspaces/{id}/inspection", s.handleWorkspaceInspection, workspaceRole(viewer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/inspection/rescan", s.handleWorkspaceInspection, workspaceRole(member, pathWorkspace("id"))),

		fn("GET /api/devices", s.handleListDevices, filtered()),
		fn("POST /api/devices/pairing-tokens", s.handleCreateDevicePairingToken, signedIn()),
		// A pairing that waits for its creator's choice to share a system
		// account (device_sharing.go); the token names it, the caller must
		// have created it.
		fn("POST /api/devices/pairing-tokens/status", s.handleDevicePairingStatus, signedIn()),
		fn("POST /api/devices/pairing-tokens/consent", s.handleDevicePairingConsent, signedIn()),
		fn("POST /api/devices/{deviceId}/system-account-notice/dismiss", s.handleDismissSystemAccountNotice, deviceOwner("deviceId")),
		fn("DELETE /api/devices/{deviceId}", s.handleDeleteDevice, deviceRemovalOwner("deviceId")),
		fn("PATCH /api/devices/{deviceId}", s.handleRenameDevice, deviceOwner("deviceId")),
		// Labels and detected facts (device_placement.go): the caller's own devices.
		fn("GET /api/device-placements", s.handleListDevicePlacements, filtered()),
		fn("PUT /api/devices/{deviceId}/labels", s.handleSetDeviceLabels, deviceOwner("deviceId")),
		// Files outside the device's workspaces (device_files.go): its owner
		// only, signed in; the handlers refuse admins and session tokens too.
		fn("GET /api/devices/{deviceId}/files", s.handleReadDeviceFile, deviceOwner("deviceId")),
		fn("GET /api/devices/{deviceId}/files/download", s.handleDownloadDeviceFile, deviceOwner("deviceId")),
		fn("PUT /api/devices/{deviceId}/outside-files", s.handleSetDeviceOutsideFiles, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/worker/update", s.handleUpdateWorker, deviceOwner("deviceId")),
		fn("GET /api/devices/{deviceId}/worker/runner", s.handleReadDeviceRunner, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/worker/runner/switch", s.handleSwitchDeviceRunner, deviceOwner("deviceId")),
		fn("POST /api/devices/runtime-settings", s.handleUpsertAgentRuntimeSettings, inHandler()),
		fn("POST /api/devices/{id}/resources/refresh", s.handleRefreshDeviceResources, inHandler()),
		fn("GET /api/resources", s.handleListResources, filtered()),
		// A resource's device owner (checked in the handlers).
		fn("POST /api/resources/{id}/release", s.handleReleaseResource, inHandler()),
		fn("POST /api/resources/{id}/extend", s.handleLetResourceFinish, inHandler()),
		fn("GET /api/resources/{id}/operations", s.handleResourceOperations, inHandler()),
		fn("POST /api/devices/{deviceId}/resources/stop", s.handleStopDeviceResources, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/resources/install", s.handleInstallResourceBackend, deviceOwner("deviceId")),
		fn("PUT /api/devices/{deviceId}/resources/settings", s.handleResourceSettings, deviceOwner("deviceId")),
		fn("GET /api/provider-health", s.handleProviderHealth, filtered()),
		fn("POST /api/devices/{deviceId}/accounts/{runtime}/inspect", s.handleInspectNativeAccount, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/accounts/{runtime}/install", s.handleInstallNativeCli, deviceOwner("deviceId")),
		fn("PUT /api/devices/{deviceId}/profiles", s.handleSetDeviceProfiles, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/external-connections/{profileId}/check", s.handleCheckExternalConnection, deviceOwner("deviceId")),
		fn("DELETE /api/devices/{deviceId}/external-connections/{profileId}", s.handleRemoveExternalConnection, deviceOwner("deviceId")),
		fn("PUT /api/devices/{deviceId}/skill-roots", s.handleSetDeviceSkillRoots, deviceOwner("deviceId")),
		fn("GET /api/device-skills", s.handleListDeviceSkills, filtered()),
		fn("POST /api/device-skills/scan", s.handleScanDeviceSkills, inHandler()),

		fn("GET /api/agent-profiles", s.handleListAgentProfiles, filtered()),
		fn("POST /api/agent-profiles", s.handleCreateAgentProfile, inHandler()),
		fn("POST /api/agent-profiles/resume-account", s.handleResumeNativeAccount, inHandler()),
		fn("POST /api/agent-profiles/models", s.handleListAgentModels, inHandler()),
		fn("GET /api/profiles", s.handleListProfiles, filtered()),
		fn("POST /api/profiles", s.handleCreateProfile, signedIn()),
		fn("POST /api/profiles/promote", s.handlePromoteProfile, inHandler()),
		fn("PUT /api/profiles/{id}", s.handleUpdateProfile, connectionOwner("id")),
		fn("DELETE /api/profiles/{id}", s.handleDeleteProfile, connectionOwner("id")),
		fn("POST /api/profiles/{id}/credential/clear", s.handleClearProfileCredential, connectionOwner("id")),

		// External accounts (external_accounts.go): a person's own logins at
		// third-party platforms; a workspace's bindings.
		fn("GET /api/external-accounts", s.handleExternalAccountsView, filtered()),
		fn("POST /api/external-apps", s.handleCreateExternalApp, inHandler()),
		fn("DELETE /api/external-apps/{id}", s.handleDeleteExternalApp, inHandler()),
		fn("PUT /api/external-apps/{id}/secret", s.handleReplaceExternalAppSecret, inHandler()),
		fn("POST /api/external-accounts/connect", s.handleConnectExternalAccount, inHandler()),
		fn("POST /api/external-accounts/setup", s.handleSetupExternalAccount, inHandler()),
		fn("GET /api/external-accounts/logins/{id}", s.handleExternalAccountLogin, inHandler()),
		fn("GET /api/external-accounts/{id}", s.handleGetExternalAccount, externalAccountOwner("id")),
		fn("PATCH /api/external-accounts/{id}", s.handleUpdateExternalAccount, externalAccountOwner("id")),
		fn("DELETE /api/external-accounts/{id}", s.handleDisconnectExternalAccount, externalAccountOwner("id")),
		fn("POST /api/external-accounts/{id}/refresh", s.handleRefreshExternalAccount, externalAccountOwner("id")),
		fn("POST /api/external-accounts/{id}/revoke", s.handleRevokeExternalAccount, externalAccountOwner("id")),
		// The Feishu gateway (external_accounts_gateway.go): what feishu-cli
		// on a session's device sends through the worker's forwarder, and
		// its audit, read by the people whose sessions made the calls.
		fn("GET "+feishugateway.PathPrefix+"/{path...}", s.handleFeishuGateway, daemonProtocol()),
		fn("POST "+feishugateway.PathPrefix+"/{path...}", s.handleFeishuGateway, daemonProtocol()),
		fn("PUT "+feishugateway.PathPrefix+"/{path...}", s.handleFeishuGateway, daemonProtocol()),
		fn("PATCH "+feishugateway.PathPrefix+"/{path...}", s.handleFeishuGateway, daemonProtocol()),
		fn("DELETE "+feishugateway.PathPrefix+"/{path...}", s.handleFeishuGateway, daemonProtocol()),
		fn("GET /api/feishu-gateway/requests", s.handleFeishuGatewayRequests, signedIn()),
		fn("GET /api/workspaces/{id}/external-accounts", s.handleWorkspaceExternalAccounts, workspaceRole(viewer, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/external-accounts", s.handleSetWorkspaceExternalAccounts, workspaceRole(maintainer, pathWorkspace("id"))),
		// Device-held connectors (connectors.go): the credential stays on the
		// device; only its owner reads, installs, signs in or out, and binds it
		// (the handlers also refuse an Admin acting on an ownerless device).
		fn("POST /api/connectors/cloudflare/sign-in", s.handleCloudflareBegin, personOnly()),
		fn("GET /api/connectors/cloudflare/oauth/callback", s.handleCloudflareCallback, personOnly()),
		fn("DELETE /api/connectors/cloudflare/logins/{id}", s.handleCloudflareCancel, personOnly()),
		fn("GET /api/connectors/cloudflare/accounts/{accountId}/zones", s.handleCloudflareZones, externalAccountOwner("accountId")),
		fn("POST /api/connectors/cloudflare/session-handle", s.handleCloudflareSessionHandle, daemonProtocol()),
		fn("GET /api/connectors/cloudflare/gateway/{path...}", s.handleCloudflareGateway, daemonProtocol()),
		fn("GET /api/connectors/devices", s.handleDeviceConnectorsView, signedIn()),
		fn("POST /api/devices/{deviceId}/connectors/{kind}/check", s.handleCheckDeviceConnector, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/connectors/{kind}/install", s.handleInstallDeviceConnector, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/connectors/{kind}/sign-in", s.handleBeginDeviceConnectorSignIn, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/connectors/{kind}/sign-in/poll", s.handlePollDeviceConnectorSignIn, deviceOwner("deviceId")),
		fn("GET /api/devices/{deviceId}/connectors/{kind}/sign-in/image", s.handleDeviceConnectorAuthorizationImage, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/connectors/{kind}/sign-in/dismiss", s.handleDismissDeviceConnectorAuthorization, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/connectors/{kind}/sign-out", s.handleSignOutDeviceConnector, deviceOwner("deviceId")),
		fn("GET /api/workspaces/{id}/device-connectors", s.handleWorkspaceDeviceConnectors, workspaceRole(viewer, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/device-connectors", s.handleSetWorkspaceDeviceConnectors, workspaceRole(maintainer, pathWorkspace("id"))),

		fn("GET /api/agents", s.handleListAgents, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/workspace-files", s.handleListWorkspaceFiles, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/workspace-files/read", s.handleReadWorkspaceFile, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/workspace-files/download", s.handleDownloadWorkspaceFile, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/workspace-files/tree", s.handleListWorkspaceTree, workspaceRole(viewer, queryWorkspace())),
		fn("POST /api/attachments", s.handleUploadAttachments, inHandler()),
		fn("GET /api/local-files/image", s.handleLocalImageFile, inHandler()),
		fn("GET /api/assets", s.handleListAssets, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/skills", s.handleListSkills, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/skills/catalog", s.handleListPromotedSkills, signedIn()),
		fn("GET /api/builtin-skills/foundry", s.handleFoundrySkill, signedIn()),
		fn("POST /api/skills/promote", s.handlePromoteSkill, inHandler()),
		fn("POST /api/skills/promote-plan", s.handleSkillPromotionPlan, inHandler()),
		fn("POST /api/skills/compare", s.handleSkillCompare, inHandler()),
		fn("POST /api/skills/compare-file", s.handleSkillCompareFile, inHandler()),
		fn("POST /api/skills/compare-package", s.handleSkillComparePackage, inHandler()),
		fn("DELETE /api/skills/catalog/{id}", s.handleDeletePromotedSkill, adminOnly()),
		fn("GET /api/skill-repositories", s.handleListSkillRepositories, signedIn()),
		fn("GET /api/skill-repositories/preview", s.handlePreviewSkillRepository, adminOnly()),
		fn("POST /api/skill-repositories/{id}/rollback", s.handleRollbackSkillBundle, adminOnly()),
		fn("POST /api/skill-repositories/{id}/resume", s.handleResumeSkillBundle, adminOnly()),
		fn("POST /api/skill-repositories/{id}/mode", s.handleSetSkillRepositoryMode, adminOnly()),
		fn("PUT /api/workspaces/{id}/skill-bundles", s.handleSetWorkspaceSkillBundles, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("POST /api/devices/{deviceId}/tools/install", s.handleInstallDeviceTool, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/diagnostics", s.handleRunDeviceDiagnostics, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/repairs", s.handleRunDeviceRepair, deviceOwner("deviceId")),
		fn("POST /api/skill-repositories", s.handleAddSkillRepository, adminOnly()),
		fn("GET /api/skill-repositories/{id}/skills", s.handleListRepositorySkills, adminOnly()),
		fn("POST /api/skill-repositories/{id}/import", s.handleImportRepositorySkills, adminOnly()),
		fn("POST /api/skill-repositories/{id}/check", s.handleCheckSkillRepository, adminOnly()),
		fn("DELETE /api/skill-repositories/{id}", s.handleDeleteSkillRepository, adminOnly()),
		fn("PUT /api/skill-repositories/{id}/source", s.handleSetSkillRepositorySource, adminOnly()),
		fn("GET /api/skills/catalog/{id}/revisions/{revision}/package", s.handleSkillPackage, signedIn()),

		fn("GET /api/personal-agent", s.handlePersonalAgentOverview, personOnly()),
		fn("GET /api/personal-agent/inbox", s.handleListPersonalAgentInbox, personOnly()),
		fn("POST /api/personal-agent/inbox", s.handleCapturePersonalAgentInbox, personOnly()),
		fn("POST /api/personal-agent/inbox/{id}/action", s.handlePersonalAgentInboxAction, personOnly()),
		fn("POST /api/personal-agent/run-preview", s.handlePersonalAgentRunPreview, personOnly()),
		fn("POST /api/personal-agent/knowledge/vaults/{vault}/assistant-access", s.handleAssistantMemoryAccess, personOnly()),
		fn("POST /api/personal-agent/knowledge/vaults/{vault}/initial-location", s.handleResetPendingKnowledgeLocation, personOnly()),
		fn("POST /api/personal-agent/knowledge/vaults/{vault}/repair-index", s.handleRepairKnowledgeIndex, personOnly()),
		fn("GET /api/personal-agent/knowledge/vaults/{vault}/entries", s.handleKnowledgeEntries, personOnly()),
		fn("POST /api/personal-agent/knowledge/vaults/{vault}/entries", s.handleKnowledgeEntryWrite, personOnly()),
		fn("GET /api/personal-agent/knowledge/vaults/{vault}/entries/{entry}/source-review", s.handleKnowledgeSourceInspect, personOnly()),
		fn("GET /api/personal-agent/knowledge/vaults/{vault}/entries/{entry}", s.handleKnowledgeEntryRead, personOnly()),
		fn("GET /api/personal-agent/knowledge/replica-cleanup", s.handleKnowledgeReplicaCleanup, personOnly()),
		fn("GET /api/personal-agent/knowledge/migrations", s.handleKnowledgeMigrations, personOnly()),
		fn("POST /api/personal-agent/knowledge/vaults/{vault}/migrate", s.handleBeginKnowledgeMigration, personOnly()),
		fn("POST /api/personal-agent/knowledge/migrations/{migration}/cancel", s.handleCancelKnowledgeMigration, personOnly()),
		fn("GET /api/personal-agent/knowledge/mutations", s.handleKnowledgeMutations, personOnly()),
		fn("GET /api/personal-agent/knowledge/publications", s.handleKnowledgePublications, personOnly()),
		fn("POST /api/personal-agent/knowledge/publications", s.handlePublishKnowledge, personOnly()),
		fn("POST /api/personal-agent/knowledge/publications/{publication}/revoke", s.handleRevokeKnowledgePublication, personOnly()),
		fn("GET /api/personal-agent/knowledge/vaults", s.handleKnowledgeVaults, personOnly()),
		fn("POST /api/personal-agent/knowledge/vaults", s.handleCreateKnowledgeVault, personOnly()),
		fn("POST /api/personal-agent/operations/{operation}/cancel-pending", s.handleCancelPendingDispatch, personOnly()),
		fn("GET /api/personal-agent/operations", s.handlePersonalAgentOperations, personOnly()),
		fn("GET /api/personal-agent/run-controls", s.handleAssistantRunControls, personOnly()),
		fn("POST /api/personal-agent/run-controls/{control}/stop", s.handleStopAssistantRun, personOnly()),
		fn("POST /api/personal-agent/memory/{id}/transfer", s.handleLegacyKnowledgeTransfer, personOnly()),
		fn("GET /api/personal-agent/context-patches", s.handleContextPatches, personOnly()),
		fn("POST /api/personal-agent/maintenance/{job}/patch", s.handleContextPatch, personOnly()),
		fn("GET /api/personal-agent/maintenance", s.handleMaintenanceList, personOnly()),
		fn("POST /api/personal-agent/maintenance/{job}", s.handleMaintenanceAction, personOnly()),
		fn("GET /api/personal-agent/runs", s.handlePersonalAgentRunSnapshots, personOnly()),
		fn("POST /api/personal-agent", s.handleSetupPersonalAgent, personOnly()),
		fn("PUT /api/personal-agent/settings", s.handleSavePersonalAgentSettings, personOnly()),
		fn("POST /api/personal-agent/timezone", s.handleFillPersonalAgentTimezone, personOnly()),
		fn("POST /api/personal-agent/home", s.handleMovePersonalAgentHome, personOnly()),
		fn("POST /api/personal-agent/stop", s.handleStopPersonalAgent, personOnly()),
		fn("POST /api/personal-agent/resume", s.handleResumePersonalAgent, personOnly()),
		fn("GET /api/personal-agent/memory", s.handleListPersonalAgentMemory, personOnly()),
		fn("POST /api/personal-agent/memory", s.handleAddPersonalAgentMemory, personOnly()),
		fn("DELETE /api/personal-agent/memory", s.handleForgetAllPersonalAgentMemory, personOnly()),
		fn("PUT /api/personal-agent/memory/{id}", s.handleEditPersonalAgentMemory, personOnly()),
		fn("POST /api/personal-agent/memory/{id}/confirm", s.handleConfirmPersonalAgentMemory, personOnly()),
		fn("DELETE /api/personal-agent/memory/{id}", s.handleForgetPersonalAgentMemory, personOnly()),
		fn("GET /api/personal-agent/proposals", s.handleListPersonalAgentProposals, personOnly()),
		fn("POST /api/personal-agent/proposals/{id}/accept", s.handleAcceptPersonalAgentProposal, personOnly()),
		fn("POST /api/personal-agent/proposals/{id}/decline", s.handleDeclinePersonalAgentProposal, personOnly()),
		fn("GET /api/personal-agent/tasks", s.handleListPersonalAgentTasks, personOnly()),
		fn("POST /api/personal-agent/tasks/{id}/stop", s.handleStopPersonalAgentTask, personOnly()),
		fn("GET /api/personal-agent/actions", s.handleListPersonalAgentActions, personOnly()),
		fn("GET /api/personal-agent/list", s.handleListPersonalAgentItems, personOnly()),
		fn("PUT /api/personal-agent/list/{id}", s.handleEditPersonalAgentItem, personOnly()),
		fn("DELETE /api/personal-agent/list/{id}", s.handleDeletePersonalAgentItem, personOnly()),

		fn("POST /api/chats/archive", s.handleArchiveChats, inHandler()),
		fn("POST /api/chats/unarchive", s.handleUnarchiveChats, inHandler()),
		fn("POST /api/chats/{id}/native-archive/retry", s.handleRetryNativeArchive, inHandler()),
		fn("GET /api/chats", s.handleListChats, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/chat-titles", s.handleListChatTitles, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/chat-layout", s.handleGetChatLayout, workspaceRole(viewer, queryWorkspace())),
		fn("POST /api/chat-layout", s.handleSaveChatLayout, inHandler()),
		fn("POST /api/chat-layout/delete-group", s.handleDeleteChatGroup, inHandler()),
		fn("POST /api/chats/{id}/title", s.handleRenameChat, workspaceRole(member, chatOrSessionWorkspace("id"))),
		fn("POST /api/chats/{id}/recap-title", s.handleRecapChatTitle, workspaceRole(member, chatOrSessionWorkspace("id"))),
		fn("GET /api/chats/{id}", s.handleGetChat, workspaceRole(viewer, chatWorkspace("id"))),
		fn("GET /api/chats/{id}/history", s.handleGetChatHistory, workspaceRole(viewer, chatWorkspace("id"))),
		// A chat's queued messages. Changing them takes control of the chat:
		// its starter or a maintainer (in handler).
		fn("GET /api/chats/{id}/queue", s.handleGetChatQueue, workspaceRole(viewer, chatOrSessionWorkspace("id"))),
		fn("POST /api/chats/{id}/queue", s.handleEnqueueChatMessage, workspaceRole(member, chatOrSessionWorkspace("id"))),
		fn("PUT /api/chats/{id}/queue/order", s.handleReorderChatQueue, workspaceRole(member, chatOrSessionWorkspace("id"))),
		fn("PATCH /api/chats/{id}/queue/{itemId}", s.handleEditChatQueueItem, workspaceRole(member, chatOrSessionWorkspace("id"))),
		fn("DELETE /api/chats/{id}/queue/{itemId}", s.handleDeleteChatQueueItem, workspaceRole(member, chatOrSessionWorkspace("id"))),
		fn("POST /api/chats/{id}/queue/{itemId}/steer", s.handleSteerChatQueueItem, workspaceRole(member, chatOrSessionWorkspace("id"))),
		fn("POST /api/chats/{id}/queue/{itemId}/retry", s.handleRetryChatQueueItem, workspaceRole(member, chatOrSessionWorkspace("id"))),

		fn("GET /api/issues", s.handleListIssues, workspaceRoleOrDeletedFromDevice(viewer, queryWorkspace())),
		fn("POST /api/issues", s.handleCreateIssue, inHandler()),
		fn("GET /api/issues/{id}", s.handleGetIssue, workspaceRole(viewer, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/contracts", s.handleContracts, workspaceRole(viewer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/contracts", s.handleContracts, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/contracts/import-legacy", s.handleLegacyContractImport, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/contracts/{revision}/{action}", s.handleContractAction, issueCreatorOr(maintainer)),
		fn("POST /api/issues/{id}/clarify", s.handleEvidenceClarification, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/clarify/retry", s.handleRetryClarification, workspaceRole(member, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/review", s.handleEvidenceReview, workspaceRole(viewer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/candidate-snapshots", s.handleEvidenceSnapshot, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/verify", s.handleVerifyEvidence, issueCreatorOr(maintainer)),
		fn("POST /api/issues/{id}/human-assessments", s.handleHumanAssessment, issueCreatorOr(maintainer)),
		fn("POST /api/issues/{id}/conversation/status", s.handleIssueStatusQuestion, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/evidence", s.handleHumanEvidence, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/evidence/export", s.handleEvidenceExport, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/materials", s.handleMaterialUpload, workspaceRole(member, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/materials/{materialId}/content", s.handleMaterialContent, workspaceRole(viewer, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/{collection}", s.handleEvidenceList, workspaceRole(viewer, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/{collection}/{recordId}", s.handleEvidenceList, workspaceRole(viewer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/accept", s.handleAcceptIssue, workspaceRole(maintainer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/abandon", s.handleAbandonIssue, workspaceRole(maintainer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/request-changes", s.handleRequestChanges, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/answer", s.handleAnswerIssueQuestion, issueCreatorOr(maintainer)),
		fn("GET /api/issues/{id}/candidate-review", s.handleCandidateReview, workspaceRole(viewer, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/environment", s.handleIssueEnvironment, workspaceRole(viewer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/environment/{action}", s.handleIssueEnvironment, workspaceRole(member, issueWorkspace("id"))),

		fn("GET /api/agent-sessions", s.handleListAgentSessions, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/agent-session-threads/{id}", s.handleGetAgentSessionThread, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}", s.handleGetAgentSession, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/subagents", s.handleListAgentSubagents, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/link", s.handleGetSessionLink, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/conversation", s.handleGetAgentSessionConversation, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/subagents/{taskId}", s.handleGetAgentSubagentTranscript, workspaceRole(viewer, sessionWorkspace("id"))),
		// Files outside the workspace that only the answer names need Member (in handler).
		fn("GET /api/agent-sessions/{id}/files/read", s.handleReadSessionFile, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/files/download", s.handleDownloadSessionFile, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/files/diff", s.handleReadSessionFileDiff, workspaceRole(viewer, sessionWorkspace("id"))),
		// A background task's output and command line: members (redacted on the device).
		fn("GET /api/agent-sessions/{id}/background-tasks/{taskId}/output", s.handleReadBackgroundTaskOutput, workspaceRole(member, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions", s.handleCreateAgentSession, inHandler()),
		// Members control their own sessions; maintainers anyone's (in handler).
		fn("POST /api/agent-sessions/{id}/messages", s.handleSendAgentSessionMessage, workspaceRole(member, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions/{id}/cancel", s.handleCancelAgentSession, workspaceRole(member, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions/{id}/background-tasks/{taskId}/stop", s.handleStopBackgroundTask, workspaceRole(member, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/work", s.handleListSessionWork, workspaceRole(member, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions/{id}/work", s.handleCreateSessionWork, workspaceRole(member, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions/{id}/work/operations", s.handleControlSessionWork, workspaceRole(member, sessionWorkspace("id"))),

		// Installing a worker reads these before it has any credential.
		fn("GET /api/worker/release", s.handleWorkerRelease, publicRoute()),
		fn("GET /api/worker/packages/{file}", s.handleWorkerPackage, publicRoute()),
		fn("GET /api/worker/packages/latest/{file}", s.handleLatestWorkerPackage, publicRoute()),
		fn("POST /api/daemon/pair", s.handleDaemonPair, publicRoute()),
		fn("POST /api/daemon/register", s.handleDaemonRegister, daemonProtocol()),
		fn("POST /api/daemon/attachment-previews", s.handlePushAttachmentPreview, daemonProtocol()),
		fn("POST /api/daemon/chats/sync", s.handleDaemonSyncChats, daemonProtocol()),
		fn("GET /api/daemon/chats/running", s.handleDaemonRunningChats, daemonProtocol()),
		fn("GET /api/daemon/chats/digests", s.handleDaemonChatDigests, daemonProtocol()),
		fn("POST /api/daemon/sessions/{id}/timer-fires", s.handleDaemonTimerFire, daemonProtocol()),
		fn("GET /api/daemon/session-work", s.handleDeviceWork, daemonProtocol()),
		fn("POST /api/daemon/session-work", s.handleDeviceWork, daemonProtocol()),
		fn("POST /api/daemon/sessions/{id}/work-fire", s.handleWorkFire, daemonProtocol()),
		fn("POST /api/daemon/sessions/{id}/session-tokens", s.handleDaemonSessionToken, daemonProtocol()),
		fn("POST /api/daemon/skill-repository-fetches/{id}", s.handleDaemonSkillRepositoryUpload, daemonProtocol()),
		fn("GET /api/daemon/ws", s.handleDaemonWebSocket, daemonProtocol()),
	}
	if s.options.EnableDevReset {
		routes = append(routes, fn("POST /api/dev/reset-demo", s.handleDevResetDemo, adminOnly()))
	}
	return routes
}

// guard evaluates the route's rule before the handler and caches the scope
// for the handler's own checks.
func (s *Server) guard(rule accessRule, handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor := actorFromContext(r.Context())
		if actor.Kind != "" {
			scope, err := s.scopeFor(r.Context(), actor)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "resolve access")
				return
			}
			r = r.WithContext(contextWithScope(r.Context(), scope))
		}
		r = r.WithContext(context.WithValue(r.Context(), guardedRecordsKey{}, &guardedRecords{}))
		if !rule.check(s, w, r) {
			return
		}
		handler.ServeHTTP(w, r)
	})
}
