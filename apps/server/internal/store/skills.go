package store

type SkillPackRef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Scope       string `json:"scope,omitempty"`
	Source      string `json:"source,omitempty"`
	Version     string `json:"version"`
	WorkspaceID string `json:"workspaceId,omitempty"`
}

// DeviceSkillRoot is one scan root configured for a device. Roots the server
// supplies as defaults are reported with IsDefault=true and have no row.
type DeviceSkillRoot struct {
	DeviceID  string `json:"deviceId"`
	Path      string `json:"path"`
	IsDefault bool   `json:"isDefault"`
}

// DeviceSkill is one local skill a device observed during a scan.
type SkillDependencyStrength string

const (
	SkillDependencyRequired SkillDependencyStrength = "required"
	SkillDependencyRelated  SkillDependencyStrength = "related"
)

type SkillDependency struct {
	SkillName     string                  `json:"skillName"`
	Strength      SkillDependencyStrength `json:"strength"`
	Evidence      string                  `json:"evidence,omitempty"`
	Status        string                  `json:"status,omitempty"`
	TargetRoot    string                  `json:"targetRoot,omitempty"`
	TargetDirName string                  `json:"targetDirName,omitempty"`
}

type DeviceSkill struct {
	Manifest                []SkillFileInfo   `json:"manifest,omitempty"`
	ServerState             string            `json:"serverState,omitempty"`
	ServerRevision          int               `json:"serverRevision,omitempty"`
	ServerCandidates        []PromotedSkill   `json:"serverCandidates,omitempty"`
	DeviceID                string            `json:"deviceId"`
	Root                    string            `json:"root"`
	DirName                 string            `json:"dirName"`
	Name                    string            `json:"name"`
	Description             string            `json:"description"`
	SizeBytes               int64             `json:"sizeBytes"`
	MtimeLabel              string            `json:"mtimeLabel"`
	PromotedSkillID         string            `json:"promotedSkillId,omitempty"`
	Dependencies            []SkillDependency `json:"dependencies,omitempty"`
	DependencyAnalysisError string            `json:"dependencyAnalysisError,omitempty"`
	DependenciesAnalyzed    bool              `json:"dependenciesAnalyzed"`
	SourceDigest            string            `json:"sourceDigest,omitempty"`
}

// PromotedSkill is a server catalog entry. Content lives in revisions.
type PromotedSkill struct {
	SourceDigest string `json:"sourceDigest,omitempty"`
	// UsedByWorkspaces: the store lists workspace ids; the API answers with
	// the names of the ones the caller can see.
	UsedByWorkspaces        []string          `json:"usedByWorkspaces,omitempty"`
	ID                      string            `json:"id"`
	Name                    string            `json:"name"`
	Description             string            `json:"description"`
	OriginDeviceID          string            `json:"originDeviceId"`
	OriginDeviceLabel       string            `json:"originDeviceLabel"`
	OriginRoot              string            `json:"originRoot"`
	OriginDirName           string            `json:"originDirName"`
	LatestRevision          int               `json:"latestRevision"`
	CreatedLabel            string            `json:"createdLabel"`
	UpdatedLabel            string            `json:"updatedLabel"`
	Dependencies            []SkillDependency `json:"dependencies,omitempty"`
	DependencyAnalysisError string            `json:"dependencyAnalysisError,omitempty"`
	// Requires names the programs the latest revision runs.
	Requires []string `json:"requires,omitempty"`
}

// SessionSkillRef is a resolved (skill, revision) pair attached to a
// dispatched session. Checksum/ByteSize let the worker verify its cache.
type SessionSkillRef struct {
	SkillID  string `json:"skillId"`
	Revision int    `json:"revision"`
	Name     string `json:"name"`
	Checksum string `json:"checksum"`
	ByteSize int64  `json:"byteSize"`
	// Bundle names the bundle the skill came with, so a session can be told
	// about a large bundle as one entry instead of skill by skill.
	Bundle *SessionSkillBundle `json:"bundle,omitempty"`
}

// SessionSkillBundle is the bundle a session skill came with.
type SessionSkillBundle struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version,omitempty"`
}

// WorkspaceSkillBinding is one selected catalog entry for a workspace.
type WorkspaceSkillBinding struct {
	WorkspaceID string `json:"workspaceId"`
	SkillID     string `json:"skillId"`
	// PinnedRevision holds the workspace at one revision; 0 follows the latest.
	PinnedRevision int `json:"pinnedRevision,omitempty"`
}

// SetDeviceSkillRootsInput replaces the custom scan roots for one device.
type SetDeviceSkillRootsInput struct {
	DeviceID string   `json:"deviceId"`
	Paths    []string `json:"paths"`
}

// ReplaceDeviceSkillsInput stores one scan snapshot for one device.
type ReplaceDeviceSkillsInput struct {
	DeviceID string        `json:"deviceId"`
	Skills   []DeviceSkill `json:"skills"`
}

// PromoteSkillInput lifts one device-local skill into the server catalog.
type PromoteSkillInput struct {
	TargetSkillID  string                     `json:"-"`
	ForceNew       bool                       `json:"-"`
	Resolutions    []SkillPromotionResolution `json:"resolutions,omitempty"`
	PlanDigest     string                     `json:"planDigest,omitempty"`
	IncludeRelated []string                   `json:"includeRelated,omitempty"`
	DeviceID       string                     `json:"deviceId"`
	Root           string                     `json:"root"`
	DirName        string                     `json:"dirName"`
}

// SetWorkspaceSkillsInput replaces the workspace's whole selection.
type SetWorkspaceSkillsInput struct {
	WorkspaceID string   `json:"workspaceId"`
	SkillIDs    []string `json:"skillIds"`
	// OffSkillIDs, when sent, replaces the skills the workspace turns off
	// although its owner's defaults or its bundles give them.
	OffSkillIDs *[]string `json:"offSkillIds,omitempty"`
}

// SkillPackage is one immutable promoted revision's zip payload.
type SkillPackage struct {
	SkillID   string
	Revision  int
	Content   []byte
	Checksum  string
	ByteSize  int64
	FileCount int
}

// BuiltinSkill is a skill Foundry itself gives an agent runtime, beside the
// skills the agent ships and the ones a workspace selects.
type BuiltinSkill struct {
	Runtime     string `json:"runtime"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source"`
}

// FoundrySkillDetail is what the built-in foundry skill gives agents, for
// people: the Foundry tools with what each does, its limits and the session
// roles that get it, the guidance its SKILL.md gives, and that SKILL.md.
type FoundrySkillDetail struct {
	Name        string                  `json:"name"`
	Description string                  `json:"description,omitempty"`
	Source      string                  `json:"source"`
	Revisions   []BuiltinSkillRevision  `json:"revisions"`
	Tools       []FoundryToolCapability `json:"tools"`
	Guidance    []SkillGuidanceSection  `json:"guidance"`
	// Manifest is the SKILL.md agents read.
	Manifest string `json:"manifest"`
}

// BuiltinSkillRevision is the revision of a built-in skill an agent runtime gets.
type BuiltinSkillRevision struct {
	Runtime  string `json:"runtime"`
	Revision int    `json:"revision"`
}

// FoundryToolCapability is one Foundry MCP tool. Roles name the sessions
// that get it: "session" (a chat, the sessions agents start, people at a
// shell), "issue_execution", "issue_clarification" and "verifier".
type FoundryToolCapability struct {
	Name     string   `json:"name"`
	Summary  string   `json:"summary"`
	Limits   []string `json:"limits"`
	ReadOnly bool     `json:"readOnly"`
	Roles    []string `json:"roles"`
}

// SkillGuidanceSection is one section of a SKILL.md as points, one line each.
type SkillGuidanceSection struct {
	Heading string   `json:"heading"`
	Points  []string `json:"points"`
}

// SkillPromotionPlan is reviewed before publishing the complete required closure.
type SkillPromotionPlan struct {
	Digest   string            `json:"digest"`
	Skills   []DeviceSkill     `json:"skills"`
	Problems []string          `json:"problems"`
	Related  []SkillDependency `json:"related"`
}

type SkillPromotionPackage struct {
	Resolution SkillPromotionResolution
	Source     DeviceSkill
	Content    []byte
	FileCount  int
}

// SkillFileInfo is cached metadata; file contents are loaded on demand.
type SkillFileInfo struct {
	Path      string `json:"path"`
	Digest    string `json:"digest"`
	SizeBytes int64  `json:"sizeBytes"`
	Binary    bool   `json:"binary"`
}

type SkillRevisionIndex struct {
	SourceDigest string          `json:"sourceDigest"`
	Files        []SkillFileInfo `json:"files"`
}

type SkillFileChange struct {
	Path   string         `json:"path"`
	Kind   string         `json:"kind"`
	Before *SkillFileInfo `json:"before,omitempty"`
	After  *SkillFileInfo `json:"after,omitempty"`
}

type SkillComparison struct {
	Files     []SkillFileChange `json:"files"`
	Unchanged int               `json:"unchanged"`
	Revision  int               `json:"revision"`
}

type SkillFileComparison struct {
	Before      string `json:"before"`
	After       string `json:"after"`
	Unavailable string `json:"unavailable,omitempty"`
}

type SkillPromotionResolution struct {
	Root             string `json:"root"`
	DirName          string `json:"dirName"`
	Action           string `json:"action"`
	TargetSkillID    string `json:"targetSkillId,omitempty"`
	ExpectedRevision int    `json:"expectedRevision,omitempty"`
	Name             string `json:"name,omitempty"`
}

type SkillComparisonInput struct {
	DeviceID     string `json:"deviceId"`
	Root         string `json:"root"`
	DirName      string `json:"dirName"`
	SkillID      string `json:"skillId"`
	Revision     int    `json:"revision"`
	SourceDigest string `json:"sourceDigest"`
	Path         string `json:"path,omitempty"`
	Side         string `json:"side,omitempty"`
}
