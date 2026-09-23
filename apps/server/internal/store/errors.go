package store

import "errors"

var ErrNotFound = errors.New("not found")
var ErrWorkspaceBusy = errors.New("workspace has active work; wait for running or queued tasks to finish before removing it")
var ErrTitleConflict = errors.New("chat title changed while generating a new title")

// ErrDeviceRemoved marks a device that was soft-removed from the server. Its
// history rows are retained, but daemon (re)registration must be refused so a
// reconnecting worker cannot make the device reappear.
var ErrDeviceRemoved = errors.New("device was removed from this server")

// ErrWorkspaceOwnedByAnotherDevice refuses a registration that would move a
// workspace id away from the live device that registered it first.
var ErrWorkspaceOwnedByAnotherDevice = errors.New("workspace belongs to another device")

// ErrDeviceBusy is wrapped (with a task count) when a device still owns
// non-terminal runs or agent sessions. Device removal never stops tasks.
var ErrDeviceBusy = errors.New("device has active work")

// ErrProfileNotFound means no server profile carries the requested id.
var ErrProfileNotFound = errors.New("profile not found")

// ErrSkillNotFound means no promoted skill carries the requested id.
var ErrSkillNotFound = errors.New("skill not found")

// ErrSkillPackageNotFound means no stored revision matches the request.
var ErrSkillPackageNotFound = errors.New("skill package not found")

// ErrSkillPackageTooLarge means a promoted zip exceeded MaxSkillPackageBytes.
var ErrSkillPackageTooLarge = errors.New("skill package too large")

var ErrSkillVersionConflict = errors.New("skill version conflict")

// ErrSessionParentNotFound means a create request named a lineage parent that
// does not exist.
var ErrSessionParentNotFound = errors.New("parent session not found")

// ErrSessionParentMismatch means a named parent belongs to another workspace.
var ErrSessionParentMismatch = errors.New("parent session belongs to another workspace")

// ErrAgentLineageTooDeep means a child session would exceed the spawn-depth
// limit.
var ErrAgentLineageTooDeep = errors.New("agent lineage depth limit reached")

// ErrAgentFanOutLimit means a parent already has too many active children.
var ErrAgentFanOutLimit = errors.New("parent session has too many active children")

// ErrIssueEnvironmentUnavailable means no live candidate worktree exists for
// the requested Issue-backed session.
var ErrIssueEnvironmentUnavailable = errors.New("issue environment is not available for a session")

// ErrAgentAdoptInvalid means an adopt request targeted an ineligible session.
var ErrAgentAdoptInvalid = errors.New("session cannot be adopted")
