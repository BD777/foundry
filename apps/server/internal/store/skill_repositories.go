package store

// SkillRepository is a git repository the skill library takes skills from.
type SkillRepository struct {
	ID string `json:"id"`
	// URL is the https remote; Label is its short form, e.g.
	// "github.com/anthropics/skills".
	URL   string `json:"url"`
	Label string `json:"label"`
	// Ref is the branch or tag followed; empty follows the default branch.
	Ref string `json:"ref,omitempty"`
	// Subpath is the folder within the repository holding the skills.
	Subpath string `json:"subpath,omitempty"`
	// Commit is the commit last seen at Ref.
	Commit    string `json:"commit,omitempty"`
	CheckedAt string `json:"checkedAt,omitempty"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"createdAt"`
	// CreatedBy is the account that followed it; not served.
	CreatedBy string                 `json:"-"`
	Skills    []SkillRepositorySkill `json:"skills"`
	// Mode is "pick" (chosen skills) or "bundle" (the whole repository as
	// one unit). Either way the skills move to the version the repository
	// follows by themselves.
	Mode string `json:"mode"`
	// Name is a bundle's name, e.g. "feishu-cli".
	Name string `json:"name,omitempty"`
	// Version is the release tag (or short commit) the repository's skills
	// are on.
	Version string `json:"version,omitempty"`
	// Paused: a rolled-back repository stays on its version until resumed.
	Paused bool `json:"paused,omitempty"`
	// Versions are the applied versions, newest first.
	Versions []SkillBundleVersion `json:"versions,omitempty"`
	// Tools are programs a bundle's skills run, with where to get them.
	Tools []SkillBundleTool `json:"tools,omitempty"`
	// DeclaredTools are programs named when the bundle was followed, which
	// its source does not publish itself (e.g. a Python CLI on PyPI).
	DeclaredTools []SkillToolDeclaration `json:"declaredTools,omitempty"`
	// FoundCount is how many skill folders the repository held when it was
	// last read; 0 when not known.
	FoundCount int `json:"foundCount,omitempty"`
	// Description is the repository's own description from its host.
	Description string `json:"description,omitempty"`
	// FetchDeviceID names the device that reads the repository, with its own
	// git and npm settings and credentials, for a source the server cannot
	// reach; empty means the server reads it.
	FetchDeviceID string `json:"fetchDeviceId,omitempty"`
	// FetchDeviceName is that device's name; FetchDeviceOnline says whether
	// it is connected now (filled in when the repository is served).
	FetchDeviceName   string `json:"fetchDeviceName,omitempty"`
	FetchDeviceOnline bool   `json:"fetchDeviceOnline,omitempty"`
	// Registry is the npm registry (an https URL) an npm source and the npm
	// tools it needs come from; empty is the public registry when the server
	// reads it, and the device's own npm settings when a device does.
	Registry string `json:"registry,omitempty"`
	// CheckWaiting: a check could not run because the fetch device was
	// offline; it runs when the device reconnects.
	CheckWaiting bool `json:"checkWaiting,omitempty"`
	// UpdatePolicy is how a bundle with tools moves devices to a new
	// version: BundleUpdateAuto (stored as "") or BundleUpdateManual.
	UpdatePolicy string `json:"updatePolicy,omitempty"`
	// Rollout is the latest move of the bundle's devices to a version.
	Rollout *SkillBundleRollout `json:"rollout,omitempty"`
	// DeviceVersions is where each device that has one of the bundle's
	// tools stands (filled in when the repository is served).
	DeviceVersions []BundleDeviceVersion `json:"deviceVersions,omitempty"`
}

// How a bundle with tools follows new versions (docs/skills.md, Bundle 版本).
const (
	BundleUpdateAuto   = "auto"
	BundleUpdateManual = "manual"
)

// SkillBundleCheck is the outcome of checking a bundle version on a device.
type SkillBundleCheck struct {
	State      string                 `json:"state"`
	DeviceID   string                 `json:"deviceId"`
	DeviceName string                 `json:"deviceName,omitempty"`
	At         string                 `json:"at"`
	Steps      []SkillBundleCheckStep `json:"steps"`
	// Forced: a drill made the check fail after its real steps.
	Forced bool `json:"forced,omitempty"`
}

// SkillBundleCheckStep is one step of a check: `--version`, or one of the
// connector's commands. State is passed, failed or skipped. A passed step
// keeps no output (it can name the account): Kind and Value say what it
// showed in one line, Service names the connector for a command.
type SkillBundleCheckStep struct {
	Name  string `json:"name"`
	State string `json:"state"`
	// Detail is why a step failed or was skipped (redacted), never the
	// output of one that passed.
	Detail string `json:"detail,omitempty"`
	// Kind is "version", or the command's declared result: "status",
	// "refresh" or "read".
	Kind string `json:"kind,omitempty"`
	// Value is what the one-line result names: the version, or the value
	// at the command's show path (an account's display name).
	Value   string `json:"value,omitempty"`
	Service string `json:"service,omitempty"`
}

// The states of a check and its steps.
const (
	CheckPassed  = "passed"
	CheckFailed  = "failed"
	CheckSkipped = "skipped"
)

// SkillBundleRollout is one move of a bundle's devices to a version.
type SkillBundleRollout struct {
	ID string `json:"id"`
	// Seq and Tag name the bundle version moved to.
	Seq     int    `json:"seq"`
	Tag     string `json:"tag"`
	Trigger string `json:"trigger"`
	// State is one of the Rollout* constants.
	State          string                     `json:"state"`
	CanaryDeviceID string                     `json:"canaryDeviceId,omitempty"`
	Devices        []SkillBundleRolloutDevice `json:"devices"`
	StartedAt      string                     `json:"startedAt"`
	FinishedAt     string                     `json:"finishedAt,omitempty"`
	Error          string                     `json:"error,omitempty"`
	// FailCheck: a drill; the canary's check fails after its real steps.
	FailCheck bool `json:"failCheck,omitempty"`
}

// The states of a rollout.
const (
	RolloutWaiting    = "waiting"
	RolloutCanary     = "canary"
	RolloutRolling    = "rolling"
	RolloutDone       = "done"
	RolloutFailed     = "failed"
	RolloutRolledBack = "rolled_back"
)

// Finished reports whether a rollout has ended.
func (r SkillBundleRollout) Finished() bool {
	return r.State == RolloutDone || r.State == RolloutFailed || r.State == RolloutRolledBack
}

// SkillBundleRolloutDevice is one device's part in a rollout.
type SkillBundleRolloutDevice struct {
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName,omitempty"`
	// Owner names, when served, the person a device belongs to if it is
	// not the viewer's.
	Owner string `json:"owner,omitempty"`
	// From names the tool versions it was on, e.g. "feishu-cli v1.41.0".
	From string `json:"from,omitempty"`
	// State is one of the RolloutDevice* constants.
	State string            `json:"state"`
	Error string            `json:"error,omitempty"`
	Check *SkillBundleCheck `json:"check,omitempty"`
}

// The states of a device in a rollout.
const (
	RolloutDevicePending    = "pending"
	RolloutDeviceInstalling = "installing"
	RolloutDeviceChecking   = "checking"
	RolloutDeviceUpdated    = "updated"
	RolloutDeviceFailed     = "failed"
	RolloutDeviceOffline    = "offline"
	RolloutDeviceRolledBack = "rolled_back"
)

// BundleDeviceVersion is where one device stands with a bundle: the tool
// versions Foundry installed there and the bundle version they match,
// which is the one its sessions get skills from.
type BundleDeviceVersion struct {
	DeviceID string            `json:"deviceId"`
	Tools    map[string]string `json:"tools"`
	Seq      int               `json:"seq,omitempty"`
	Tag      string            `json:"tag,omitempty"`
	// State is current, behind or unknown (a tool version no recorded
	// version has).
	State    string `json:"state"`
	Verified bool   `json:"verified,omitempty"`
}

// The states of a device's bundle version.
const (
	DeviceBundleCurrent = "current"
	DeviceBundleBehind  = "behind"
	DeviceBundleUnknown = "unknown"
)

// SessionToolPin is a tool version a session runs: the version its bundle
// skills were chosen for.
type SessionToolPin struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	BundleID string `json:"bundleId,omitempty"`
	Bundle   string `json:"bundle,omitempty"`
	Verified bool   `json:"verified,omitempty"`
}

// SkillBundleSummary is a bundle as workspaces choose it.
type SkillBundleSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Label   string `json:"label"`
	Version string `json:"version,omitempty"`
	// SkillIDs are the library skills it delivers now.
	SkillIDs []string `json:"skillIds"`
}

// SkillBundleVersion is one version a bundle was updated or rolled back to.
type SkillBundleVersion struct {
	Seq       int    `json:"seq"`
	Tag       string `json:"tag"`
	Commit    string `json:"commit"`
	AppliedAt string `json:"appliedAt"`
	// RolledBack marks a rollback to an earlier version's skills.
	RolledBack bool     `json:"rolledBack,omitempty"`
	Added      []string `json:"added,omitempty"`
	Changed    []string `json:"changed,omitempty"`
	Removed    []string `json:"removed,omitempty"`
	// Missing are picked skills whose folder left the repository with this
	// version; the library keeps them at their last revision.
	Missing []string `json:"missing,omitempty"`
	// Members are the skills and revisions this version consists of.
	Members []SkillBundleMember `json:"members,omitempty"`
	// Tools are the programs this version needs, at their versions; rolling
	// back to it restores them with its skills.
	Tools []SkillBundleTool `json:"tools,omitempty"`
	// Check is this version's check on a rollout's canary device.
	Check *SkillBundleCheck `json:"check,omitempty"`
}

// SkillBundleMember is one skill of a bundle version.
type SkillBundleMember struct {
	Dir      string `json:"dir"`
	SkillID  string `json:"skillId"`
	Name     string `json:"name"`
	Revision int    `json:"revision"`
}

// SkillToolDeclaration names a program a bundle needs. Source "uv" installs
// the PyPI package Package and Source "npm" the npm package Package (from
// the repository's registry), which provides Command. Source "repository"
// takes the files at Path in the bundle's own upstream repository and
// exposes Bins; its version is the bundle commit.
type SkillToolDeclaration struct {
	Source  string            `json:"source"`
	Package string            `json:"package"`
	Command string            `json:"command"`
	Path    string            `json:"path,omitempty"`
	Bins    map[string]string `json:"bins,omitempty"`
}

// SkillRepositorySkill is a library skill taken from a repository folder.
type SkillRepositorySkill struct {
	SkillID string `json:"skillId"`
	Dir     string `json:"dir"`
	// Commit is the repository commit the skill's latest revision came from.
	Commit string `json:"commit"`
	// Name is the skill's name in the library.
	Name string `json:"name,omitempty"`
	// Retired: the skill left its bundle; sessions no longer get it.
	Retired bool `json:"retired,omitempty"`
	// Missing: a picked skill's folder is gone from the repository; the
	// library keeps its last revision.
	Missing bool `json:"missing,omitempty"`
}

// RepositoryOrigin is the origin device id of library skills taken from a
// repository; their origin root is the repository label and their origin
// folder the skill's folder in it.
func RepositoryOrigin(repositoryID string) string { return "repo:" + repositoryID }

// DeviceTool says whether a device has a program some library skill needs,
// as its worker found on its PATH at the last skill scan.
type DeviceTool struct {
	DeviceID  string `json:"deviceId"`
	Tool      string `json:"tool"`
	Available bool   `json:"available"`
	// CheckedAt is when the device first gave its current answer; a scan
	// that finds the same answer leaves it.
	CheckedAt string `json:"checkedAt"`
	// Version is the version Foundry installed on the device, if it did.
	Version string `json:"version,omitempty"`
}

// RepositorySkillFolder is a skill folder found in a repository.
type RepositorySkillFolder struct {
	// Dir is the folder relative to the repository root.
	Dir         string `json:"dir"`
	Name        string `json:"name"`
	Description string `json:"description"`
	License     string `json:"license,omitempty"`
	// SkillID is set when the folder is already in the library.
	SkillID string `json:"skillId,omitempty"`
}

// SkillRepositoryView is a repository with the skill folders it holds now.
type SkillRepositoryView struct {
	Repository SkillRepository         `json:"repository"`
	Available  []RepositorySkillFolder `json:"available"`
}
