package store

import (
	"slices"
	"strings"
)

// Session sources and the classes readers derive from a session's source
// and status. They mirror packages/protocol/src/session-classes.ts
// (SessionSource<Key> is sessionSources.<key>); scripts/audit-contract.mjs
// pins the two sides.
//
// A verifier (SessionSourceVerification) reads the workspace and runs
// commands that only read, in a sandbox its worker keeps the workspace
// read-only in (worker: verification-session.ts); its Foundry tools are the
// ones that change nothing (httpapi mcpToolAvailability). A digest
// (SessionSourceDigest) summarizes for the Personal Agent, read-only and
// without Foundry tools.
const (
	SessionSourceChat         = "chat"
	SessionSourceDiagnostic   = "diagnostic"
	SessionSourceNaming       = "naming"
	SessionSourceVerification = "verification"
	SessionSourceMaintenance  = "maintenance"
	SessionSourceAgent        = "agent"
	SessionSourceIssue        = "issue"
	SessionSourceDigest       = "digest"
)

// ActiveSessionStatuses are the statuses of a session still doing work:
// steer and cancel are legal, it holds an execution slot and the leases and
// grants of its turn, and a stale device recovers from them.
var ActiveSessionStatuses = []string{"queued", "running", "blocked"}

// UtilitySessionSources start the sessions Foundry starts for itself:
// read-only, a few turns, no tools beyond reading, no Connectors. A
// verifier is a role of its own.
var UtilitySessionSources = []string{SessionSourceDiagnostic, SessionSourceNaming, SessionSourceMaintenance, SessionSourceDigest}

// PromptOnlySessionSources start utility sessions that read only their
// prompt, which carries all their data: no tools, no inherited context,
// and not listed as chats.
var PromptOnlySessionSources = []string{SessionSourceNaming, SessionSourceDigest}

// The sets as SQL lists, for `status IN ...` and `source NOT IN ...`.
var (
	ActiveSessionStatusesSQL    = SQLStringList(ActiveSessionStatuses...)
	PromptOnlySessionSourcesSQL = SQLStringList(PromptOnlySessionSources...)
)

func IsActiveSessionStatus(status string) bool {
	return slices.Contains(ActiveSessionStatuses, status)
}

func IsUtilitySessionSource(source string) bool {
	return slices.Contains(UtilitySessionSources, source)
}

func IsPromptOnlySessionSource(source string) bool {
	return slices.Contains(PromptOnlySessionSources, source)
}

// SQLStringList is values as a parenthesized SQL list of string literals,
// for fixed vocabularies only: values must not contain a quote.
func SQLStringList(values ...string) string {
	return "('" + strings.Join(values, "', '") + "')"
}
