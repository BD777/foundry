package httpapi

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A workspace's Feishu Bot is a Connectors Feishu app plus routes: the
// workspace's maintainers pick the app (one they may connect through) and
// pair chats with codes; the server holds the secret and the connection.

func generatePairingCode() string {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	var sb strings.Builder
	sb.WriteString("FND-")
	for i := 0; i < 4; i++ {
		num, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			sb.WriteString("8")
		} else {
			sb.WriteByte(charset[num.Int64()])
		}
	}
	return sb.String()
}

const feishuProviderKind = "feishu"

var errFeishuBotsUnavailable = errors.New("Feishu bots are not available on this server")

// feishuBotChoices are the Feishu apps the caller may run a bot on: their
// own Connectors apps and the instance-wide ones.
func (s *Server) feishuBotChoices(ctx context.Context, userID string) ([]store.ExternalProviderApp, error) {
	if s.externalAccounts == nil || userID == "" {
		return []store.ExternalProviderApp{}, nil
	}
	apps, err := s.externalAccounts.ListApps(ctx, userID)
	if err != nil {
		return nil, err
	}
	choices := []store.ExternalProviderApp{}
	for _, app := range apps {
		if app.Provider == feishuProviderKind {
			choices = append(choices, app)
		}
	}
	return choices, nil
}

// writeWorkspaceFeishuBot answers with the workspace's bot and the apps
// the caller may run it on.
func (s *Server) writeWorkspaceFeishuBot(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if s.feishu == nil {
		writeError(w, http.StatusServiceUnavailable, errFeishuBotsUnavailable.Error())
		return
	}
	view, err := s.feishu.WorkspaceBot(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if view.Choices, err = s.feishuBotChoices(r.Context(), actorFromContext(r.Context()).AccountID()); err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleGetWorkspaceFeishuBot(w http.ResponseWriter, r *http.Request) {
	s.writeWorkspaceFeishuBot(w, r, r.PathValue("id"))
}

// handleSaveWorkspaceFeishuBot runs the workspace's bot on a Connectors
// Feishu app: one the caller may connect through, or the one it runs on.
func (s *Server) handleSaveWorkspaceFeishuBot(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	var input store.SelectWorkspaceFeishuBotInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	appID := strings.TrimSpace(input.AppID)
	if appID == "" {
		writeError(w, http.StatusBadRequest, "appId (a Connectors Feishu app) is required")
		return
	}
	accounts, ok := s.store.(store.ExternalAccountStore)
	if !ok || s.feishu == nil {
		writeError(w, http.StatusServiceUnavailable, errFeishuBotsUnavailable.Error())
		return
	}
	app, err := accounts.GetExternalProviderApp(r.Context(), appID)
	current, _ := s.feishu.WorkspaceBot(r.Context(), workspaceID)
	runsOn := current.App != nil && current.App.ID == appID
	if err != nil || app.Provider != feishuProviderKind ||
		(!runsOn && app.OwnerUserID != actorFromContext(r.Context()).AccountID() && app.Visibility != store.ExternalAppInstance) {
		writeError(w, http.StatusNotFound, "Feishu app not found in your Connectors")
		return
	}
	if err := s.store.SetWorkspaceFeishuBotApp(r.Context(), workspaceID, app.ID); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.feishu.Sync(context.WithoutCancel(r.Context()))
	s.writeWorkspaceFeishuBot(w, r, workspaceID)
}

// handleGenerateFeishuPairingCode issues a code that binds the chat it is
// sent in to the workspace; the chat then acts as the caller.
func (s *Server) handleGenerateFeishuPairingCode(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	code := generatePairingCode()
	expiresAt := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	route, err := s.store.SetFeishuPairingCode(r.Context(), workspaceID, feishu.HashPairingCode(code), actorFromContext(r.Context()).AccountID(), expiresAt)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "pick the Feishu app the bot runs on first")
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, store.FeishuPairingCodeResult{
		WorkspaceID:          workspaceID,
		PairingCode:          code,
		PairingCodeExpiresAt: route.PairingCodeExpiresAt,
	})
}

// handleUnbindFeishuChat stops routing one chat to the workspace.
func (s *Server) handleUnbindFeishuChat(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if err := s.store.DeleteFeishuBotRoute(r.Context(), workspaceID, r.PathValue("routeId")); err != nil {
		writeResult(w, nil, err)
		return
	}
	if s.feishu != nil {
		s.feishu.Publish(context.WithoutCancel(r.Context()), workspaceID)
	}
	s.writeWorkspaceFeishuBot(w, r, workspaceID)
}

// handleDeleteWorkspaceFeishuBot removes the workspace's bot: its app stays
// in Connectors, and keeps serving other workspaces.
func (s *Server) handleDeleteWorkspaceFeishuBot(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if err := s.store.DeleteWorkspaceFeishuBot(r.Context(), workspaceID); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.feishuBotsChanged(r.Context(), workspaceID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// feishuBotsChanged runs the bots on what the routes say now, and tells the
// workspaces that no longer have a bot.
func (s *Server) feishuBotsChanged(ctx context.Context, removed ...string) {
	if s.feishu == nil {
		return
	}
	ctx = context.WithoutCancel(ctx)
	s.feishu.Sync(ctx)
	for _, workspaceID := range removed {
		s.feishu.Publish(ctx, workspaceID)
	}
}

// handleFeishuAppUses lists, for each Feishu app the caller may see in
// Connectors, the workspaces whose bot runs on it, the agent subscriptions
// open on it and its connection.
func (s *Server) handleFeishuAppUses(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	if s.feishu == nil {
		writeError(w, http.StatusServiceUnavailable, errFeishuBotsUnavailable.Error())
		return
	}
	apps, err := s.feishuBotChoices(r.Context(), actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return
	}
	uses := []store.FeishuAppUse{}
	for _, app := range apps {
		routes, err := s.store.ListFeishuBotRoutes(r.Context(), store.FeishuBotRouteFilter{AppID: app.ID})
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		use := store.FeishuAppUse{AppID: app.ID, Workspaces: []store.FeishuAppWorkspaceUse{}}
		chats := map[string]int{}
		var order []string
		for _, route := range routes {
			if route.Kind == store.FeishuRoutePairing {
				order = append(order, route.WorkspaceID)
			} else {
				chats[route.WorkspaceID]++
			}
		}
		for _, workspaceID := range order {
			workspace, err := s.store.GetWorkspace(r.Context(), workspaceID)
			if err != nil || scope.role(workspaceID) == "" {
				use.OtherWorkspaces++
				continue
			}
			use.Workspaces = append(use.Workspaces, store.FeishuAppWorkspaceUse{WorkspaceID: workspaceID, Name: workspace.Name, Chats: chats[workspaceID]})
		}
		if s.feishuEvents != nil {
			use.Subscriptions = s.feishuEvents.Subscriptions(app.ClientID)
		}
		if len(order) > 0 {
			use.Status, use.StatusDetail, use.LastEventAt = s.feishu.AppStatus(app.ClientID)
		} else if s.feishuEvents != nil {
			status := s.feishuEvents.Status(app.ClientID)
			use.Status = store.FeishuBotStatusUnconfigured
			if status.Connected {
				use.Status = store.FeishuBotStatusConnected
			}
			if !status.LastEventAt.IsZero() {
				use.LastEventAt = status.LastEventAt.UTC().Format(time.RFC3339)
			}
		}
		uses = append(uses, use)
	}
	writeJSON(w, http.StatusOK, uses)
}

// feishuReactions hands Feishu what its group threads follow: a session's
// answer as it streams and how it ended, and what happens to an Issue.
type feishuReactions struct{ manager *feishu.WSManager }

func (f feishuReactions) sessionChanged(_ context.Context, change sessionChange, session store.AgentSession) {
	if change == sessionCompleted {
		f.manager.SessionEnded(session)
	}
}

func (f feishuReactions) sessionEventRecorded(_ context.Context, event store.AgentSessionEvent) {
	f.manager.SessionEventRecorded(event)
}

func (f feishuReactions) issueUpdated(issue store.Issue) {
	f.manager.IssueUpdated(issue)
}
