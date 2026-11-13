package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// workerProxySettingsCapability marks a worker that answers set_worker_proxy.
const workerProxySettingsCapability = "worker_proxy_settings"

type wsWorkerProxySet struct {
	// Proxy is the saved proxy's scheme, host and port; empty once cleared.
	Proxy string `json:"proxy,omitempty"`
	Error string `json:"error,omitempty"`
}

// handleSetDeviceWorkerProxy saves or clears the proxy a device's worker
// reaches the server through, for its owner: the device page's answer to a
// proxy that stopped working (DEV-217). The worker validates the address and
// reconnects on the new route; the address, which may carry credentials, is
// passed through and never stored or logged here.
func (s *Server) handleSetDeviceWorkerProxy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL   *string `json:"url"`
		Clear bool    `json:"clear"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(w, r.Body, 8<<10), &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	payload := map[string]any{}
	switch {
	case body.Clear && body.URL == nil:
		payload["clear"] = true
	case !body.Clear && body.URL != nil && strings.TrimSpace(*body.URL) != "" && len(*body.URL) <= 2048:
		payload["url"] = strings.TrimSpace(*body.URL)
	default:
		writeError(w, http.StatusBadRequest, "Give a proxy address, or ask to stop using the proxy.")
		return
	}
	connection, ok := s.runnerConnection(w, r)
	if !ok {
		return
	}
	if !connection.hasCapability(workerProxySettingsCapability) {
		writeError(w, http.StatusConflict, "This device's Worker is too old to change its proxy from here; update the Worker first.")
		return
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	value, err := daemonRequest[wsWorkerProxySet](ctx, connection, wsSetWorkerProxyType, encoded)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if value.Error != "" {
		writeError(w, http.StatusBadRequest, value.Error)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"proxy": value.Proxy})
}
