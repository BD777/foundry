package sqlitestore

// indexStatements covers the predicates and orderings the workspace-scoped
// list queries actually use today. Each index mirrors one concrete query.
func indexStatements() []string {
	return []string{
		// ListIssues / ClaimNextIssue
		`CREATE INDEX IF NOT EXISTS idx_issues_workspace_updated ON issues (workspace_id, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_issues_status_updated ON issues (status, updated_at ASC)`,
		`CREATE INDEX IF NOT EXISTS idx_issues_short_id ON issues (short_id)`,
		// ListRuns and the runs join behind ListRunEvents
		`CREATE INDEX IF NOT EXISTS idx_runs_workspace_updated ON runs (workspace_id, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs (issue_id)`,
		// ListRunEvents
		`CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events (run_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_run_events_created ON run_events (created_at DESC)`,
		// ListAgentSessions / GetAgentSession
		`CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_updated ON agent_sessions (workspace_id, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_agent_session_events_session_created ON agent_session_events (session_id, created_at ASC)`,
		// ListAgents / getAgent / replaceWorkspaceAgents
		`CREATE INDEX IF NOT EXISTS idx_agents_workspace_device ON agents (workspace_id, device_id)`,
		`CREATE INDEX IF NOT EXISTS idx_agents_workspace_provider_updated ON agents (workspace_id, provider, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_agents_device ON agents (device_id)`,
		// ListAgentProfiles
		`CREATE INDEX IF NOT EXISTS idx_agent_profiles_device_runtime ON agent_profiles (device_id, runtime, id)`,
		// ListWorkspaceFiles / ListAssets / ListSkills and their replacements
		`CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace_path ON workspace_files (workspace_id, path)`,
		`CREATE INDEX IF NOT EXISTS idx_assets_workspace_name ON assets (workspace_id, name)`,
		`CREATE INDEX IF NOT EXISTS idx_skills_workspace_name ON skills (workspace_id, name)`,
		// acceptance artifacts are looked up and deleted by issue
		`CREATE INDEX IF NOT EXISTS idx_acceptance_artifacts_issue ON acceptance_artifacts (issue_id)`,
	}
}
