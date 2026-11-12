// Package knowledge is the person's knowledge (docs/personal-agent.md §2):
// sources kept as files in a workspace folder on one of their devices (a
// vault: the person's memory, or a project's domain knowledge), indexed on
// the server, and changed only through durable jobs the device confirms.
// It holds the vaults and their entries, the writes and forgets (mutations),
// moving a vault to another folder (migrations), the explicit grants that
// let a session of another workspace read a source (publications), the
// cleanup of copies a migration left behind (replica forgets), and the
// assistant's recall of its confirmed memory.
//
// Every file access is authorized again on use (Workspace): a cached index
// or a reference never makes a formerly private workspace safe. It does
// not know HTTP or the device wire: httpapi runs the knowledge commands on
// devices (Devices), applies the workspace lifecycle
// (personalagent.Workspaces), lists accounts (run.Accounts), and answers a
// refusal (personalagent.Refusal) with its status.
//
//	svc := knowledge.New(st, devices, workspaces, runs, accounts)
//	svc.Drain(ctx)                                   // every queue by one pass (background)
//	svc.AuthorizedVault(ctx, user, vaultID)          // a vault its person may use now
//	svc.ReadEntry(ctx, vault, entryID, includeExpired)
//	svc.Recall(ctx, session, RecallRequest{…})       // read_knowledge
//	svc.CheckPublication(ctx, session, publication)  // may this session read it
//
// Dependencies: store, personalagent (its rules and flow keys) and
// personalagent/run. It must not import httpapi.
package knowledge

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what knowledge keeps and reads.
type Store interface {
	store.Store
	store.AccountStore
	store.OwnershipStore
	store.DeviceSharingStore
	store.PersonalAgentStore
	store.KnowledgeVaultStore
	store.KnowledgeEntryStore
	store.KnowledgeMigrationStore
	store.KnowledgeLegacyTransferStore
	store.KnowledgeReplicaCleanupStore
	store.KnowledgePublicationStore
}

// Devices runs knowledge commands on the device that holds a vault;
// httpapi implements it over its device hub.
type Devices interface {
	// KnowledgeCommand runs command in workspace's folder on its device.
	KnowledgeCommand(ctx context.Context, workspace store.WorkspaceProjection, command store.KnowledgeCommand) (store.KnowledgeReply, error)
}

// Service is the knowledge subsystem. It holds no state of its own (only
// the retry spacing of drainLegacyMemory, in memory).
type Service struct {
	store      Store
	devices    Devices
	workspaces personalagent.Workspaces
	runs       *run.Resolver
	accounts   run.Accounts
}

// New is the knowledge service over st and its ports.
func New(st Store, devices Devices, workspaces personalagent.Workspaces, runs *run.Resolver, accounts run.Accounts) *Service {
	return &Service{store: st, devices: devices, workspaces: workspaces, runs: runs, accounts: accounts}
}

func invalid(format string, args ...any) error { return personalagent.Invalid(format, args...) }
