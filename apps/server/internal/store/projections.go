package store

type FoundryDataProjection struct {
	Runs                   []Run                    `json:"runs,omitempty"`
	Workspace              WorkspaceProjection      `json:"workspace"`
	Workspaces             []WorkspaceProjection    `json:"workspaces"`
	Devices                []DeviceProjection       `json:"devices"`
	ProviderHealth         []ProviderHealth         `json:"providerHealth"`
	AgentProfiles          []AgentProfileProjection `json:"agentProfiles"`
	Profiles               []ProfileDefinition      `json:"profiles"`
	DeviceProfiles         []DeviceProfileBinding   `json:"deviceProfiles"`
	DeviceSkillRoots       []DeviceSkillRoot        `json:"deviceSkillRoots"`
	PromotedSkills         []PromotedSkill          `json:"promotedSkills"`
	BuiltinSkills          []BuiltinSkill           `json:"builtinSkills,omitempty"`
	WorkspaceSkillBindings []WorkspaceSkillBinding  `json:"workspaceSkillBindings"`
	// DefaultSkillIDs: the owner's default skills the workspace gets, those
	// not replaced by a selected skill of the same name.
	DefaultSkillIDs []string `json:"defaultSkillIds,omitempty"`
	// InheritedSkillIDs: skills the workspace gets without selecting them
	// (defaults and bundles), including ones it turned off; OffSkillIDs the
	// ones it turned off.
	InheritedSkillIDs []string `json:"inheritedSkillIds,omitempty"`
	OffSkillIDs       []string `json:"offSkillIds,omitempty"`
	// SkillBundles are the library's bundles; WorkspaceBundleIDs the ones
	// this workspace uses, selected or from its owner's defaults;
	// DefaultBundleIDs its owner's default bundles.
	SkillBundles       []SkillBundleSummary `json:"skillBundles,omitempty"`
	WorkspaceBundleIDs []string             `json:"workspaceBundleIds,omitempty"`
	DefaultBundleIDs   []string             `json:"defaultBundleIds,omitempty"`
	// DeviceTools: which programs library skills need the visible devices
	// have.
	DeviceTools    []DeviceTool         `json:"deviceTools,omitempty"`
	Agents         []AgentProjection    `json:"agents"`
	WorkspaceFiles []WorkspaceFileEntry `json:"workspaceFiles"`
	AgentSessions  []AgentSession       `json:"agentSessions"`
	Skills         []SkillPackRef       `json:"skills"`
	Issues         []Issue              `json:"issues"`
	Chats          []ChatThread         `json:"chats"`
	Assets         []AssetProjection    `json:"assets"`
}
