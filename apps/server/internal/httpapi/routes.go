package httpapi

import (
	"errors"
	"net/http"
	"strings"

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
		return session.WorkspaceID, err
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

func (s *Server) requireDeviceOwner(w http.ResponseWriter, r *http.Request, deviceID string) bool {
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
	credentials, ok := s.store.(store.DeviceCredentialStore)
	if !ok {
		return "", errNoOwnershipStore
	}
	return credentials.DeviceOwner(r.Context(), deviceID)
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
		{pattern: "GET /api/events", handler: s.events, rule: filtered()},
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
		fn("GET /api/workspaces/{id}/feishu", s.handleGetWorkspaceFeishuBot, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/feishu", s.handleSaveWorkspaceFeishuBot, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/feishu/pair-code", s.handleGenerateFeishuPairingCode, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/feishu/unbind", s.handleUnbindFeishuGroup, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("DELETE /api/workspaces/{id}/feishu", s.handleDeleteWorkspaceFeishuBot, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("GET /api/workspaces/{id}/members", s.handleListWorkspaceMembers, workspaceRole(viewer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/members", s.handleAddWorkspaceMember, workspaceRole(owner, pathWorkspace("id"))),
		fn("PATCH /api/workspaces/{id}/members/{userId}", s.handleUpdateWorkspaceMember, workspaceRole(owner, pathWorkspace("id"))),
		// Owners remove anyone; any member may leave (in handler).
		fn("DELETE /api/workspaces/{id}/members/{userId}", s.handleRemoveWorkspaceMember, inHandler()),
		fn("GET /api/workspaces/{id}/skills", s.handleListWorkspaceSkills, workspaceRole(viewer, pathWorkspace("id"))),
		fn("PUT /api/workspaces/{id}/skills", s.handleSetWorkspaceSkills, workspaceRole(maintainer, pathWorkspace("id"))),
		fn("GET /api/workspaces/{id}/inspection", s.handleWorkspaceInspection, workspaceRole(viewer, pathWorkspace("id"))),
		fn("POST /api/workspaces/{id}/inspection/rescan", s.handleWorkspaceInspection, workspaceRole(member, pathWorkspace("id"))),

		fn("GET /api/devices", s.handleListDevices, filtered()),
		fn("POST /api/devices/pairing-tokens", s.handleCreateDevicePairingToken, signedIn()),
		fn("DELETE /api/devices/{deviceId}", s.handleDeleteDevice, deviceOwner("deviceId")),
		fn("POST /api/devices/runtime-settings", s.handleUpsertAgentRuntimeSettings, inHandler()),
		fn("GET /api/provider-health", s.handleProviderHealth, filtered()),
		fn("POST /api/devices/{deviceId}/accounts/{runtime}/inspect", s.handleInspectNativeAccount, deviceOwner("deviceId")),
		fn("PUT /api/devices/{deviceId}/profiles", s.handleSetDeviceProfiles, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/accounts/{runtime}/authorization", s.handleStartDeviceAuthorization, deviceOwner("deviceId")),
		fn("POST /api/devices/{deviceId}/accounts/{runtime}/authorization/{flowId}", s.handleCompleteDeviceAuthorization, deviceOwner("deviceId")),
		fn("PUT /api/devices/{deviceId}/skill-roots", s.handleSetDeviceSkillRoots, deviceOwner("deviceId")),
		fn("GET /api/device-skills", s.handleListDeviceSkills, filtered()),
		fn("POST /api/device-skills/scan", s.handleScanDeviceSkills, inHandler()),

		fn("GET /api/agent-profiles", s.handleListAgentProfiles, filtered()),
		fn("POST /api/agent-profiles", s.handleCreateAgentProfile, inHandler()),
		fn("POST /api/agent-profiles/models", s.handleListAgentModels, inHandler()),
		fn("GET /api/profiles", s.handleListProfiles, filtered()),
		fn("POST /api/profiles", s.handleCreateProfile, signedIn()),
		fn("POST /api/profiles/promote", s.handlePromoteProfile, inHandler()),
		fn("PUT /api/profiles/{id}", s.handleUpdateProfile, connectionOwner("id")),
		fn("DELETE /api/profiles/{id}", s.handleDeleteProfile, connectionOwner("id")),
		fn("POST /api/profiles/{id}/credential/clear", s.handleClearProfileCredential, connectionOwner("id")),
		fn("POST /api/profiles/{id}/authorization", s.handleStartProfileAuthorization, connectionOwner("id")),
		fn("POST /api/profiles/{id}/authorization/{flowId}", s.handleCompleteProfileAuthorization, connectionOwner("id")),

		fn("GET /api/agents", s.handleListAgents, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/workspace-files", s.handleListWorkspaceFiles, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/workspace-files/read", s.handleReadWorkspaceFile, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/workspace-files/tree", s.handleListWorkspaceTree, workspaceRole(viewer, queryWorkspace())),
		fn("POST /api/attachments", s.handleUploadAttachments, inHandler()),
		fn("GET /api/local-files/image", s.handleLocalImageFile, inHandler()),
		fn("GET /api/assets", s.handleListAssets, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/skills", s.handleListSkills, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/skills/catalog", s.handleListPromotedSkills, signedIn()),
		fn("POST /api/skills/promote", s.handlePromoteSkill, inHandler()),
		fn("POST /api/skills/promote-plan", s.handleSkillPromotionPlan, inHandler()),
		fn("POST /api/skills/compare", s.handleSkillCompare, inHandler()),
		fn("POST /api/skills/compare-file", s.handleSkillCompareFile, inHandler()),
		fn("POST /api/skills/compare-package", s.handleSkillComparePackage, inHandler()),
		fn("DELETE /api/skills/catalog/{id}", s.handleDeletePromotedSkill, adminOnly()),
		fn("GET /api/skills/catalog/{id}/revisions/{revision}/package", s.handleSkillPackage, signedIn()),

		fn("GET /api/chats", s.handleListChats, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/chat-titles", s.handleListChatTitles, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/chat-layout", s.handleGetChatLayout, workspaceRole(viewer, queryWorkspace())),
		fn("POST /api/chat-layout", s.handleSaveChatLayout, inHandler()),
		fn("POST /api/chat-layout/delete-group", s.handleDeleteChatGroup, inHandler()),
		fn("POST /api/chats/{id}/title", s.handleRenameChat, workspaceRole(member, chatWorkspace("id"))),
		fn("POST /api/chats/{id}/recap-title", s.handleRecapChatTitle, workspaceRole(member, chatWorkspace("id"))),
		fn("GET /api/chats/{id}", s.handleGetChat, workspaceRole(viewer, chatWorkspace("id"))),

		fn("GET /api/issues", s.handleListIssues, workspaceRole(viewer, queryWorkspace())),
		fn("POST /api/issues", s.handleCreateIssue, inHandler()),
		fn("GET /api/issues/{id}", s.handleGetIssue, workspaceRole(viewer, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/contracts", s.handleContracts, workspaceRole(viewer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/contracts", s.handleContracts, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/contracts/import-legacy", s.handleLegacyContractImport, workspaceRole(member, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/contracts/{revision}/{action}", s.handleContractAction, issueCreatorOr(maintainer)),
		fn("POST /api/issues/{id}/clarify", s.handleEvidenceClarification, workspaceRole(member, issueWorkspace("id"))),
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
		fn("GET /api/issues/{id}/candidate-review", s.handleCandidateReview, workspaceRole(viewer, issueWorkspace("id"))),
		fn("GET /api/issues/{id}/environment", s.handleIssueEnvironment, workspaceRole(viewer, issueWorkspace("id"))),
		fn("POST /api/issues/{id}/environment/{action}", s.handleIssueEnvironment, workspaceRole(member, issueWorkspace("id"))),

		fn("GET /api/runs", s.handleListRuns, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/run-events", s.handleListRunEvents, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/agent-sessions", s.handleListAgentSessions, workspaceRole(viewer, queryWorkspace())),
		fn("GET /api/agent-session-threads/{id}", s.handleGetAgentSessionThread, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}", s.handleGetAgentSession, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/subagents", s.handleListAgentSubagents, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("GET /api/agent-sessions/{id}/subagents/{taskId}", s.handleGetAgentSubagentTranscript, workspaceRole(viewer, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions", s.handleCreateAgentSession, inHandler()),
		// Members control their own sessions; maintainers anyone's (in handler).
		fn("POST /api/agent-sessions/{id}/steer", s.handleSteerAgentSession, workspaceRole(member, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions/{id}/cancel", s.handleCancelAgentSession, workspaceRole(member, sessionWorkspace("id"))),
		fn("POST /api/agent-sessions/{id}/adopt", s.handleAdoptAgentSession, workspaceRole(member, sessionWorkspace("id"))),

		fn("POST /api/daemon/pair", s.handleDaemonPair, publicRoute()),
		fn("POST /api/daemon/register", s.handleDaemonRegister, daemonProtocol()),
		fn("POST /api/daemon/chats/sync", s.handleDaemonSyncChats, daemonProtocol()),
		fn("GET /api/daemon/ws", s.handleDaemonWebSocket, daemonProtocol()),
		fn("POST /api/daemon/issues/claim", s.handleDaemonClaimIssue, daemonProtocol()),
		fn("POST /api/daemon/issues/{id}/recover-claim", s.handleRecoverIssueClaim, daemonProtocol()),
		fn("POST /api/daemon/issues/{id}/runs", s.handleDaemonStartRun, daemonProtocol()),
		fn("POST /api/daemon/runs/{id}/events", s.handleDaemonAppendRunEvent, daemonProtocol()),
		fn("POST /api/daemon/issues/{id}/complete", s.handleDaemonCompleteIssue, daemonProtocol()),
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
		if !rule.check(s, w, r) {
			return
		}
		handler.ServeHTTP(w, r)
	})
}
