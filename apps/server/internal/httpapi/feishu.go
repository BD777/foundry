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

func (s *Server) handleGetWorkspaceFeishuBot(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}
	bot, err := s.store.GetWorkspaceFeishuBot(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, bot)
}

func (s *Server) handleSaveWorkspaceFeishuBot(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}
	var input store.SaveWorkspaceFeishuBotInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}

	appID := strings.TrimSpace(input.AppID)
	appSecret := strings.TrimSpace(input.AppSecret)
	if appID == "" {
		writeError(w, http.StatusBadRequest, "appId is required")
		return
	}

	existing, err := s.store.GetWorkspaceFeishuBot(r.Context(), workspaceID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeResult(w, nil, err)
		return
	}

	secretToUse := appSecret
	if appSecret != "" {
		if s.secrets != nil {
			_ = s.secrets.PutSecret(r.Context(), "feishu:app_secret:"+workspaceID, []byte(appSecret), "feishu-app-secret")
		}
	} else if existing.HasAppSecret && s.secrets != nil {
		secretBytes, err := s.secrets.GetSecret(r.Context(), "feishu:app_secret:"+workspaceID)
		if err == nil {
			secretToUse = string(secretBytes)
		}
	}

	existing.WorkspaceID = workspaceID
	existing.AppID = appID
	existing.Status = store.FeishuBotStatusConnecting
	existing.StatusDetail = ""

	saved, err := s.store.SaveWorkspaceFeishuBot(r.Context(), existing)
	if err != nil {
		writeResult(w, nil, err)
		return
	}

	if secretToUse != "" && s.feishu != nil {
		_ = s.feishu.StartBot(workspaceID, appID, secretToUse)
	}

	writeJSON(w, http.StatusOK, saved)
}

func (s *Server) handleGenerateFeishuPairingCode(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}

	bot, err := s.store.GetWorkspaceFeishuBot(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}

	code := generatePairingCode()
	expiresAt := time.Now().Add(10 * time.Minute).Format(time.RFC3339)

	// The group that redeems this code acts as the account generating it.
	bot.PairingCode = feishu.HashPairingCode(code)
	bot.PairingCodeExpiresAt = expiresAt
	bot.PairingCodeCreatedBy = actorFromContext(r.Context()).AccountID()

	saved, err := s.store.SaveWorkspaceFeishuBot(r.Context(), bot)
	if err != nil {
		writeResult(w, nil, err)
		return
	}

	writeJSON(w, http.StatusOK, store.FeishuPairingCodeResult{
		WorkspaceID:          workspaceID,
		PairingCode:          code,
		PairingCodeExpiresAt: saved.PairingCodeExpiresAt,
	})
}

func (s *Server) handleUnbindFeishuGroup(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}

	bot, err := s.store.GetWorkspaceFeishuBot(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}

	bot.ChatID = ""
	bot.ChatName = ""
	bot.BoundUserID = ""
	saved, err := s.store.SaveWorkspaceFeishuBot(r.Context(), bot)
	if err != nil {
		writeResult(w, nil, err)
		return
	}

	writeJSON(w, http.StatusOK, saved)
}

func (s *Server) handleDeleteWorkspaceFeishuBot(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}

	if s.feishu != nil {
		s.feishu.StopBot(workspaceID)
	}

	if err := s.store.DeleteWorkspaceFeishuBot(r.Context(), workspaceID); err != nil {
		writeResult(w, nil, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
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
