package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestFeishuHttpApi(t *testing.T) {
	st := newTestStore(t)
	server := NewServer(st)
	defer server.Shutdown(context.Background())

	wsList, err := st.ListWorkspaces(context.Background())
	if err != nil || len(wsList) == 0 {
		t.Fatalf("no workspaces in test store: %v", err)
	}
	workspaceID := wsList[0].ID

	// 1. GET initial state
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces/"+workspaceID+"/feishu", nil)
	rec := httptest.NewRecorder()
	server.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get feishu bot status: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var bot store.WorkspaceFeishuBot
	if err := json.Unmarshal(rec.Body.Bytes(), &bot); err != nil {
		t.Fatalf("unmarshal bot: %v", err)
	}
	if bot.Status != store.FeishuBotStatusUnconfigured {
		t.Errorf("expected unconfigured, got %s", bot.Status)
	}

	// 2. POST save config
	body := `{"appId":"cli_test_12345","appSecret":"sec_test_secret"}`
	req = httptest.NewRequest(http.MethodPost, "/api/workspaces/"+workspaceID+"/feishu", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	server.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("save feishu bot: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var saved store.WorkspaceFeishuBot
	if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
		t.Fatalf("unmarshal saved: %v", err)
	}
	if saved.AppID != "cli_test_12345" {
		t.Errorf("expected appId cli_test_12345, got %s", saved.AppID)
	}

	// 3. POST generate pair code
	req = httptest.NewRequest(http.MethodPost, "/api/workspaces/"+workspaceID+"/feishu/pair-code", nil)
	rec = httptest.NewRecorder()
	server.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("generate pair code: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var pairResp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &pairResp); err != nil {
		t.Fatalf("unmarshal pair code: %v", err)
	}
	if !strings.HasPrefix(pairResp["pairingCode"], "FND-") {
		t.Errorf("expected FND- prefix in pairing code, got %s", pairResp["pairingCode"])
	}
	stored, err := st.GetWorkspaceFeishuBot(context.Background(), workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.PairingCode != feishu.HashPairingCode(pairResp["pairingCode"]) {
		t.Errorf("stored pairing code must be the hash of the returned code")
	}
	if stored.PairingCodeCreatedBy != testOwner.ID {
		t.Errorf("pairing code creator = %q, want %q", stored.PairingCodeCreatedBy, testOwner.ID)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/workspaces/"+workspaceID+"/feishu", nil)
	rec = httptest.NewRecorder()
	server.Routes().ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "pairingCode\"") || strings.Contains(rec.Body.String(), stored.PairingCode) {
		t.Errorf("GET must not expose the pairing code: %s", rec.Body.String())
	}

	// 4. POST unbind group
	req = httptest.NewRequest(http.MethodPost, "/api/workspaces/"+workspaceID+"/feishu/unbind", nil)
	rec = httptest.NewRecorder()
	server.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unbind: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// 5. DELETE bot
	req = httptest.NewRequest(http.MethodDelete, "/api/workspaces/"+workspaceID+"/feishu", nil)
	rec = httptest.NewRecorder()
	server.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete bot: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}
