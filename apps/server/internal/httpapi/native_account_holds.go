package httpapi

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"strings"
)

func (s *Server) handleResumeNativeAccount(w http.ResponseWriter, r *http.Request) {
	var input struct {
		DeviceID  string `json:"deviceId"`
		ProfileID string `json:"profileId"`
		HoldID    string `json:"holdId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, input.DeviceID) {
		return
	}
	// A model may observe a suspension, but only the person may override it.
	if actorFromContext(r.Context()).Agent() {
		writeError(w, http.StatusForbidden, "Only a person can resume an official account.")
		return
	}
	if input.HoldID == "" || input.ProfileID == "" {
		writeError(w, http.StatusBadRequest, "profileId and holdId are required")
		return
	}
	holds, ok := s.store.(store.NativeAccountHoldStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "Account recovery is unavailable.")
		return
	}
	if err := holds.ResumeNativeAccount(r.Context(), input.DeviceID, input.ProfileID, input.HoldID); err != nil {
		writeError(w, http.StatusConflict, "The account or suspension changed. Refresh before resuming.")
		return
	}
	s.projectionsChanged("", fieldAgentProfiles, fieldAgents)
	writeJSON(w, http.StatusOK, map[string]bool{"resumed": true})
}

func (c *daemonConnection) observeNativeAccountHold(ctx context.Context, sessionID, inputID, code string) error {
	if code != "account_on_hold" || inputID == "" {
		return nil
	}
	holds, ok := c.hub.store.(store.NativeAccountHoldStore)
	if !ok {
		return nil
	}
	if err := holds.ObserveNativeAccountHold(ctx, sessionID, inputID, code); err != nil {
		return err
	}
	c.hub.dataChanges.changed("", fieldAgentProfiles, fieldAgents)
	return nil
}

// Compatibility with older native runners' terminal error envelope. Do not
// classify generic 401/403, model text or tool output as account suspension.
func nativeAccountTerminalError(message string) string {
	if strings.Contains(message, "(error type account_on_hold)") && strings.Contains(message, "Your account is on hold") {
		return "account_on_hold"
	}
	return ""
}
