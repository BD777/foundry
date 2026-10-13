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
	Commit    string                 `json:"commit,omitempty"`
	CheckedAt string                 `json:"checkedAt,omitempty"`
	Error     string                 `json:"error,omitempty"`
	CreatedAt string                 `json:"createdAt"`
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
}

// SkillBundleMember is one skill of a bundle version.
type SkillBundleMember struct {
	Dir      string `json:"dir"`
	SkillID  string `json:"skillId"`
	Name     string `json:"name"`
	Revision int    `json:"revision"`
}

// SkillBundleTool is a program a bundle needs, installable from the
// repository's GitHub release of the bundle's version.
type SkillBundleTool struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	// Assets are the release downloads per platform.
	Assets []SkillToolAsset `json:"assets,omitempty"`
	// ChecksumsURL is the release's checksum list, when it publishes one.
	ChecksumsURL string `json:"checksumsUrl,omitempty"`
	// Source is where it installs from: "" (a GitHub release download),
	// "npm" (the npm package Package at Version) or "uv" (the Python
	// package Package at Version, through uv).
	Source  string `json:"source,omitempty"`
	Package string `json:"package,omitempty"`
	// Registry is where an npm tool installs from: "" the public registry,
	// an https URL that registry, or "device" each device's own npm
	// settings (its npmrc and scoped registries).
	Registry string `json:"registry,omitempty"`
	// Setup is a step the tool needs after installing (e.g. downloading its
	// browser), run only when the person asks.
	Setup *SkillToolSetup `json:"setup,omitempty"`
	// SignIn is the command a person runs once in a terminal on each device
	// after installing (e.g. "auth login"); Foundry only shows it.
	SignIn []string `json:"signIn,omitempty"`
}

// SkillToolDeclaration names a program a bundle needs that its source
// does not publish: Source "uv" installs the PyPI package Package and
// Source "npm" the npm package Package (from the repository's registry),
// which provides the command Command. Its version follows the bundle's when
// the package has that version, else the package's latest.
type SkillToolDeclaration struct {
	Source  string `json:"source"`
	Package string `json:"package"`
	Command string `json:"command"`
}

// SkillToolSetup runs one of the installed package's commands with fixed
// arguments.
type SkillToolSetup struct {
	// Command is a command the package installs; empty is the tool itself.
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args"`
	// Description says what it does, e.g. "Downloads Chrome for Testing".
	Description string `json:"description"`
}

// SkillToolAsset is one platform's download of a tool.
type SkillToolAsset struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
	Name string `json:"name"`
	URL  string `json:"url"`
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
