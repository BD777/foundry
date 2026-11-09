package connectors

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// toolCheckLifetime bounds how long a check's stand-ins work.
const toolCheckLifetime = 5 * time.Minute

// ToolCheck is what checking a new version of a tool runs on a device
// beyond `--version` (docs/skills.md, Bundle 版本): the commands the
// catalog declares for the connector whose command the tool is, and, for a
// server-held connector, stand-ins for one of the device owner's accounts
// that work only while the check does. A tool no connector checks has no
// commands.
type ToolCheck struct {
	Kind string
	// Label names the connector to people ("Feishu").
	Label     string
	Commands  []store.ConnectorVersionCheckCommand
	Materials []store.ExternalAccountMaterial
	// Skipped says why the commands cannot run on this device.
	Skipped string
	end     func()
}

// End ends the check: its stand-ins stop working.
func (c ToolCheck) End() {
	if c.end != nil {
		c.end()
	}
}

// CheckedConnector is the connector whose command tool is and that
// declares a version check.
func (m *Module) CheckedConnector(tool string) (store.ConnectorDescriptor, bool) {
	for _, descriptor := range m.catalog.All() {
		if descriptor.Tool.Command == tool && descriptor.Tool.VersionCheck != nil && len(descriptor.Tool.VersionCheck.Commands) > 0 {
			return descriptor, true
		}
	}
	return store.ConnectorDescriptor{}, false
}

// UsableAccount reports whether deviceOwner has an account a check of
// tool could act with: a check prefers such a device.
func (m *Module) UsableAccount(ctx context.Context, tool, deviceOwner string) bool {
	descriptor, ok := m.CheckedConnector(tool)
	if !ok || descriptor.Holding != store.ConnectorServerHeld {
		return false
	}
	_, found := m.checkAccount(ctx, descriptor.Kind, deviceOwner)
	return found
}

func (m *Module) checkAccount(ctx context.Context, kind, deviceOwner string) (store.ExternalAccount, bool) {
	if deviceOwner == "" || !m.ServerHeld.SecretsConfigured() {
		return store.ExternalAccount{}, false
	}
	accounts, err := m.ServerHeld.Accounts(ctx, deviceOwner)
	if err != nil {
		return store.ExternalAccount{}, false
	}
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].ID < accounts[j].ID })
	for _, account := range accounts {
		if account.Provider == kind && account.OwnerUserID == deviceOwner && account.Mode == store.ExternalCredentialServerHeld &&
			(account.Status == store.ExternalAccountReady || account.Status == store.ExternalAccountExpiring) {
			return account, true
		}
	}
	return store.ExternalAccount{}, false
}

// PrepareToolCheck is the check of tool on deviceID, owned by deviceOwner.
// Call End when the check is over.
func (m *Module) PrepareToolCheck(ctx context.Context, tool, deviceID, deviceOwner string) ToolCheck {
	descriptor, ok := m.CheckedConnector(tool)
	if !ok {
		return ToolCheck{}
	}
	check := ToolCheck{Kind: descriptor.Kind, Label: descriptor.Label, Commands: descriptor.Tool.VersionCheck.Commands}
	if descriptor.Holding != store.ConnectorServerHeld {
		check.Skipped = fmt.Sprintf("%s is device-held; its commands are not checked yet", descriptor.Label)
		return check
	}
	account, found := m.checkAccount(ctx, descriptor.Kind, deviceOwner)
	if !found {
		check.Skipped = fmt.Sprintf("the device's owner has no usable %s account to check with", descriptor.Label)
		return check
	}
	grant := m.ToolChecks.Begin(deviceID, deviceOwner, account.ID, toolCheckLifetime)
	check.end = func() { m.ToolChecks.End(grant.ID) }
	material, err := m.ServerHeld.CheckMaterial(ctx, account, grant.ID, deviceID)
	if err != nil {
		check.End()
		check.end = nil
		check.Skipped = fmt.Sprintf("no stand-ins for the %s account: %v", descriptor.Label, err)
		return check
	}
	check.Materials = []store.ExternalAccountMaterial{material}
	return check
}

// SetToolVersions records the versions of connector tools Foundry runs on
// devices, for the parts of a connector that follow its tool's version
// (the Feishu scope preset follows feishu-cli).
func (m *Module) SetToolVersions(versions map[string]string) {
	for _, descriptor := range m.catalog.All() {
		if descriptor.Holding == store.ConnectorServerHeld {
			externalaccounts.SetToolVersion(descriptor.Tool.Command, versions[descriptor.Tool.Command])
		}
	}
}
