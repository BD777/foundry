package httpapi

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestKnowledgeMemoryLocationRechecksPrivacy(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	v := store.KnowledgeVault{ID: "vault", UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"}
	if _, err := f.server.knowledgeWorkspace(ctx, f.aliceID, v); err != nil {
		t.Fatal(err)
	}
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_alice", f.bobID, store.WorkspaceRoleMember, f.aliceID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.knowledgeWorkspace(ctx, f.aliceID, v); err == nil {
		t.Fatal("shared workspace accepted as private memory root")
	}
	v.Kind = "domain"
	if _, err := f.server.knowledgeWorkspace(ctx, f.aliceID, v); err != nil {
		t.Fatal("domain owner unexpectedly denied", err)
	}
	v.DeviceID = "another-device"
	if _, err := f.server.knowledgeWorkspace(ctx, f.aliceID, v); err == nil {
		t.Fatal("location silently changed")
	}
}
func TestKnowledgeOfflineLocationRemainsWaiting(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	b, _ := f.server.knowledgeVaultStore()
	v, err := b.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "vault", UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.drainKnowledgeVaults(ctx)
	got, err := b.GetKnowledgeVault(ctx, f.aliceID, v.ID)
	if err != nil || got.State != "waiting" || got.Reason != "memory_device_offline" || got.DeviceID != v.DeviceID {
		t.Fatalf("offline source changed: %+v %v", got, err)
	}
}

func TestKnowledgeStaleWriteReturnsConflictWithoutQueuing(t *testing.T) {
	f := newAssistantFixture(t)
	b, _ := f.server.knowledgeVaultStore()
	_, err := b.CreateKnowledgeVault(context.Background(), store.KnowledgeVault{ID: "vault-conflict", UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	result := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/knowledge/vaults/vault-conflict/entries", `{"requestId":"stale","entryId":"existing","action":"write","expectedRevision":1,"expectedHash":"old","title":"Synthetic stale edit","body":"Must not overwrite a different source version"}`))
	if result.Code != http.StatusConflict {
		t.Fatalf("stale source: %d %s", result.Code, result.Body.String())
	}
	entries, _ := f.server.knowledgeEntryStore()
	jobs, err := entries.ListKnowledgeMutations(context.Background(), f.aliceID)
	if err != nil || len(jobs) != 0 {
		t.Fatalf("conflict queued a write: %+v %v", jobs, err)
	}
}

func TestKnowledgeFileRefusalsRetainRecoverableHTTPStatus(t *testing.T) {
	for code, want := range map[string]int{"external_edit": 409, "revision_conflict": 409, "unsafe_path": 400, "not_found": 404, "unexpected_io": 500} {
		t.Run(code, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeResult(rec, nil, (wsKnowledgeReply{store.KnowledgeReply{Code: code, Error: "synthetic refusal"}}).refusal())
			if rec.Code != want {
				t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}
