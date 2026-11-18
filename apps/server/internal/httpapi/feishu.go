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
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
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

// feishuBotChoices are the Feishu apps the caller may run a bot on: their
// own Connectors apps and the instance-wide ones.
func (s *Server) feishuBotChoices(ctx context.Context, userID string) ([]store.ExternalProviderApp, error) {
	if userID == "" {
		return []store.ExternalProviderApp{}, nil
	}
	apps, err := s.connectors.ServerHeld.ListApps(ctx, userID)
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
	view, err := s.feishu.WorkspaceBot(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if view.Choices, err = s.feishuBotChoices(r.Context(), actorFromContext(r.Context()).AccountID()); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.feishu.RefreshStaleChatNames(workspaceID, view.Chats)
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
	app, err := s.store.GetExternalProviderApp(r.Context(), appID)
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
// sent from to the workspace.
func (s *Server) handleGenerateFeishuPairingCode(w http.ResponseWriter, r *http.Request) {
	issued, err := s.generateFeishuPairingCode(r.Context(), r.PathValue("id"), actorFromContext(r.Context()).AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, issued)
}

// generateFeishuPairingCode stores a new code on the workspace's bot route for
// its app, valid for 10 minutes. The HTTP route and foundry_settings pair_code
// both run it. accountID is the account the paired chat acts as.
func (s *Server) generateFeishuPairingCode(ctx context.Context, workspaceID, accountID string) (store.FeishuPairingCodeResult, error) {
	code := generatePairingCode()
	hash := feishu.HashPairingCode(code)
	expiresAt := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	route, err := s.store.SetFeishuPairingCode(ctx, workspaceID, hash, accountID, expiresAt)
	if errors.Is(err, store.ErrNotFound) {
		if err := s.bindAssistantHomeBot(ctx, workspaceID, accountID); err != nil {
			return store.FeishuPairingCodeResult{}, err
		}
		route, err = s.store.SetFeishuPairingCode(ctx, workspaceID, hash, accountID, expiresAt)
	}
	if errors.Is(err, store.ErrNotFound) {
		return store.FeishuPairingCodeResult{}, &statusError{http.StatusConflict, errors.New("pick the Feishu app the bot runs on first")}
	}
	if err != nil {
		return store.FeishuPairingCodeResult{}, err
	}
	return store.FeishuPairingCodeResult{WorkspaceID: workspaceID, PairingCode: code, PairingCodeExpiresAt: route.PairingCodeExpiresAt}, nil
}

// bindAssistantHomeBot gives the default assistant's home workspace its bot,
// when it has none, on the app the assistant's direct chat runs on. It does
// nothing for any other workspace, so the caller keeps its answer.
func (s *Server) bindAssistantHomeBot(ctx context.Context, workspaceID, userID string) error {
	agent, err := s.store.DefaultAssistant(ctx, userID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && agent.WorkspaceID != workspaceID) {
		return nil
	}
	if err != nil {
		return err
	}
	if !agent.Settings.FeishuDirectChat {
		return &statusError{http.StatusConflict, errors.New("the assistant does not take Feishu direct messages: turn on its Feishu direct chat in its settings first")}
	}
	appID, err := s.assistantDirectChatApp(ctx, agent, userID)
	if err != nil {
		return err
	}
	if err := s.store.SetWorkspaceFeishuBotApp(ctx, workspaceID, appID); err != nil {
		return err
	}
	s.feishu.Sync(context.WithoutCancel(ctx))
	return nil
}

// assistantDirectChatApp is the Feishu app the assistant's direct chat runs on:
// the one its feishuAppId names, else the person's only Feishu app. With several
// apps and none named it refuses, so no app is guessed.
func (s *Server) assistantDirectChatApp(ctx context.Context, agent store.PersonalAgent, userID string) (string, error) {
	choices, err := s.feishuBotChoices(ctx, userID)
	if err != nil {
		return "", err
	}
	if named := agent.Settings.FeishuAppID; named != "" {
		for _, app := range choices {
			if app.ID == named {
				return app.ID, nil
			}
		}
		return "", &statusError{http.StatusConflict, errors.New("the Feishu app the assistant is set to (feishuAppId) is not one of your Feishu apps in Connectors")}
	}
	// A direct chat the assistant already has runs on its app: no guess is needed.
	apps := s.feishu.DirectChatAppIDs(ctx, userID, agent.ID)
	switch {
	case len(apps) == 1:
		return apps[0], nil
	case len(apps) > 1:
		return "", &statusError{http.StatusConflict, errors.New("the assistant's direct chats run on several Feishu apps: set its feishuAppId to the app its direct chat runs on, then issue the code again")}
	}
	switch len(choices) {
	case 1:
		return choices[0].ID, nil
	case 0:
		return "", &statusError{http.StatusConflict, errors.New("connect a Feishu app in Connectors first, then pair the assistant's chat")}
	default:
		return "", &statusError{http.StatusConflict, errors.New("you have several Feishu apps and the assistant names none: set its feishuAppId to the app its direct chat runs on, then issue the code again")}
	}
}

// handleUnbindFeishuChat stops routing one chat to the workspace.
func (s *Server) handleUnbindFeishuChat(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if err := s.store.DeleteFeishuBotRoute(r.Context(), workspaceID, r.PathValue("routeId")); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.feishu.Publish(context.WithoutCancel(r.Context()), workspaceID)
	s.writeWorkspaceFeishuBot(w, r, workspaceID)
}

// handleRefreshFeishuChatName asks Feishu for one chat's name now. A
// failed check keeps the name and is told in the chat's chatNameError.
func (s *Server) handleRefreshFeishuChatName(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if err := s.feishu.RefreshChatName(r.Context(), workspaceID, r.PathValue("routeId")); errors.Is(err, store.ErrNotFound) {
		writeResult(w, nil, err)
		return
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
		use.Subscriptions = s.feishuEvents.Subscriptions(app.ClientID)
		if len(order) > 0 {
			use.Status, use.StatusDetail, use.LastEventAt = s.feishu.AppStatus(app.ClientID)
		} else {
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

func (f feishuReactions) SessionChanged(_ context.Context, change sessions.Change, session store.AgentSession) {
	if change == sessions.Completed {
		f.manager.SessionEnded(session)
	}
}

func (f feishuReactions) SessionEventRecorded(_ context.Context, event store.AgentSessionEvent) {
	f.manager.SessionEventRecorded(event)
}

func (f feishuReactions) IssueUpdated(issue store.Issue) {
	f.manager.IssueUpdated(issue)
}
