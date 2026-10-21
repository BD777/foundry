package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestKnowledgePublicationBindsSourceAudienceAndAccount(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	roots, _ := f.server.knowledgeVaultStore()
	entries, _ := f.server.knowledgeEntryStore()
	pubs, _ := f.server.publicationStore()
	v, err := roots.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "memory", UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_pa", DeviceID: "dev_alice", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	source, err := entries.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "source", UserID: f.aliceID, VaultID: v.ID, EntryID: "preference", Epoch: 1, Action: "write", Title: "Short reports", Body: "Prefer short reports", SourceRef: "user-input:synthetic", RequestHash: "source-hash"})
	if err != nil {
		t.Fatal(err)
	}
	source.Status = "writing"
	source, err = entries.SaveKnowledgeMutation(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(source.Body))
	hash := hex.EncodeToString(sum[:])
	if err = entries.CompleteKnowledgeMutation(ctx, source, store.KnowledgeDocument{ID: source.EntryID, OperationID: source.ID, Revision: 1, Hash: hash, Body: source.Body, SourceRef: source.SourceRef}); err != nil {
		t.Fatal(err)
	}
	audience, err := f.server.knowledgeAudience(ctx, f.aliceID, "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	input := store.KnowledgePublication{ID: "pub", UserID: f.aliceID, VaultID: v.ID, EntryID: source.EntryID, SourceEpoch: 1, SourceRevision: 1, SourceHash: hash, TargetWorkspaceID: "ws_alice", ProfileID: "chosen-profile", ProfileFingerprint: "chosen-fingerprint", AudienceHash: audience, Purpose: "Project progress reports"}
	input.ProviderConfigHash = bindSyntheticKnowledgeAccount(t, f, "ws_alice", input.ProfileID, input.ProfileFingerprint, "Synthetic account A")
	pub, err := pubs.CreateKnowledgePublication(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", ProfileID: input.ProfileID, ProfileFingerprint: input.ProfileFingerprint}
	if err = f.server.checkKnowledgePublication(ctx, session, pub); err != nil {
		t.Fatal(err)
	}
	bindSyntheticKnowledgeAccount(t, f, "ws_alice", input.ProfileID, input.ProfileFingerprint, "Synthetic account B")
	if err = f.server.checkKnowledgePublication(ctx, session, pub); err == nil {
		t.Fatal("changed cached account inherited publication")
	}
	bindSyntheticKnowledgeAccount(t, f, "ws_alice", input.ProfileID, input.ProfileFingerprint, "Synthetic account A")
	other := session
	other.ProfileFingerprint = "different-endpoint"
	if err = f.server.checkKnowledgePublication(ctx, other, pub); err == nil {
		t.Fatal("changed provider accepted")
	}
	other = session
	other.WorkspaceID = "ws_bob"
	if err = f.server.checkKnowledgePublication(ctx, other, pub); err == nil {
		t.Fatal("different workspace accepted")
	}
	other = session
	other.CreatedByUserID = f.bobID
	if err = f.server.checkKnowledgePublication(ctx, other, pub); err == nil {
		t.Fatal("another member inherited knowledge")
	}
	if err = f.server.store.SetWorkspaceMember(ctx, "ws_alice", f.bobID, store.WorkspaceRoleMember, f.aliceID); err != nil {
		t.Fatal(err)
	}
	if err = f.server.checkKnowledgePublication(ctx, session, pub); err == nil {
		t.Fatal("new audience silently inherited publication")
	}
	revoked, err := pubs.RevokeKnowledgePublication(ctx, f.aliceID, pub.ID, pub.Revision)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := pubs.CreateKnowledgePublication(ctx, input)
	if err != nil || replay.State != "revoked" {
		t.Fatalf("grant replay revived revoked permission: %+v %v", replay, err)
	}
	if err = f.server.checkKnowledgePublication(ctx, session, revoked); err == nil {
		t.Fatal("revoked publication readable")
	}
}

func bindSyntheticKnowledgeAccount(t *testing.T, f assistantFixture, workspaceID, profileID, fingerprint, label string) string {
	t.Helper()
	ctx := context.Background()
	workspace, err := f.server.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	agent := store.AgentProjection{ID: "agent_" + workspaceID, WorkspaceID: workspaceID, DeviceID: workspace.DeviceID, Provider: "codex", ProfileID: profileID, ProfileFingerprint: fingerprint, ConnectionType: "local_login", Status: "healthy", AuthMode: "local_config", ConfigScope: "device"}
	profile := store.AgentProfileProjection{ID: profileID, DeviceID: workspace.DeviceID, Runtime: "codex", Fingerprint: fingerprint, ConnectionType: "local_login", Status: "healthy", AuthMode: "local_config", ConfigScope: "device", AccountLabel: label}
	if err = f.server.store.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: workspace.DeviceID, Status: "connected"}, Workspace: workspace, Agents: []store.AgentProjection{agent}, AgentProfiles: []store.AgentProfileProjection{profile}}); err != nil {
		t.Fatal(err)
	}
	hash, err := f.server.assistantAccountConfiguration(ctx, workspace, workspaceAccount{ProfileID: profileID, Runtime: "codex", Kind: "device_login", Usable: true, agent: agent})
	if err != nil {
		t.Fatal(err)
	}
	return hash
}
