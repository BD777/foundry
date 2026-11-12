// Package run resolves how a run of the person's assistant executes
// (docs/personal-agent.md §12): which account, model and effort a role
// (coordinator, executor, memory, governance) runs with in a workspace,
// chosen once from that workspace's accounts and pinned as a snapshot
// (store.PersonalAgentRunSnapshot) its run carries; a pinned run is checked
// again before it starts, and an account's observed configuration is
// fingerprinted so a changed provider is never chosen silently.
//
// It does not know HTTP or devices: httpapi lists the accounts a workspace
// offers and picks among them (Accounts), and answers a refusal
// (personalagent.Refusal) with its status.
//
//	runs := run.New(st, accounts)
//	runs.Resolve(ctx, agent, role, workspaceID)          // a snapshot, not kept
//	runs.Pin(ctx, agent, operationID, role, workspaceID) // kept once per operation
//	runs.CheckPinned(ctx, snapshot)                      // still runs as pinned
//	run.SessionInput(snapshot, prompt, inputID)          // the session it starts
//
// Dependencies: store, personalagent and its flow keys. It must not import
// httpapi.
package run

import (
	"context"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what resolution reads and keeps.
type Store interface {
	store.Store
	store.OwnershipStore
	store.PersonalAgentStore
	store.PermissionPackageStore
	store.PersonalAgentRuntimeStore
	store.ExecutionDefaultStore
	store.WorkerGroupStore
	store.KnowledgeVaultStore
}

// Account is one account a workspace's device offers to run a session
// under, as httpapi lists them (its workspace accounts).
type Account struct {
	ProfileID string
	Name      string
	Runtime   string
	// Kind: device_login, device_endpoint or model_service.
	Kind   string
	Usable bool
	// Problem says why it is not usable: AccountNotSignedIn or
	// AccountNotReady.
	Problem      string
	Detail       string
	LastWorkedAt string
	// Agent is the device's report of the account.
	Agent store.AgentProjection
}

// Why an account is not usable (Account.Problem).
const (
	AccountNotSignedIn = "not_signed_in"
	AccountNotReady    = "not_ready"
)

// Describe names the account as a tool's answer does.
func (a Account) Describe() string {
	return fmt.Sprintf("%q (profileId %s, %s)", a.Name, a.ProfileID, a.Runtime)
}

// Accounts lists the accounts a workspace offers; httpapi implements it.
type Accounts interface {
	// WorkspaceAccounts lists them for userID ("" anyone).
	WorkspaceAccounts(ctx context.Context, workspace store.WorkspaceProjection, userID string) ([]Account, error)
	// Pick chooses among accounts for a runtime ("" any) as a session
	// naming no account would: preferred is the person's default; ok is
	// false when none is usable.
	Pick(accounts []Account, runtime, preferred string) (Account, bool)
	// ChooseWorkerGroupMember selects one member available on the workspace's
	// computer through the server's existing worker-group allocator.
	ChooseWorkerGroupMember(ctx context.Context, group store.StoredWorkerGroup, workspace store.WorkspaceProjection) (store.WorkerGroupMember, error)
}

// Resolver resolves and pins the assistant's runs.
type Resolver struct {
	store    Store
	accounts Accounts
}

// New is a resolver over st and the workspaces' accounts.
func New(st Store, accounts Accounts) *Resolver {
	return &Resolver{store: st, accounts: accounts}
}

func invalid(format string, args ...any) error { return personalagent.Invalid(format, args...) }
