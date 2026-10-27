package sqlitestore

// coreSchema is the schema of the first tables; tables added later are
// created by their area's migration step (migrate).
func coreSchema() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS chat_archives (
          workspace_id TEXT NOT NULL, archive_key TEXT NOT NULL, archived_at TEXT NOT NULL,
          archived_by_user TEXT NOT NULL DEFAULT '', archived_by_session TEXT NOT NULL DEFAULT '', batch_id TEXT NOT NULL,
          PRIMARY KEY(workspace_id, archive_key))`,
		`CREATE INDEX IF NOT EXISTS idx_chat_archives_batch ON chat_archives(workspace_id,batch_id)`,
		`CREATE TABLE IF NOT EXISTS chat_archive_events (
          id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,at TEXT NOT NULL,
          actor_user TEXT NOT NULL,actor_session TEXT NOT NULL,restored INTEGER NOT NULL,payload_json TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS native_archive_targets (
          provider TEXT NOT NULL,native_id TEXT NOT NULL,device_id TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '',
          workspace_id TEXT NOT NULL,payload_json TEXT NOT NULL,generation INTEGER NOT NULL,
          PRIMARY KEY(provider,native_id,device_id))`,

		`CREATE TABLE IF NOT EXISTS evidence_records (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			payload_json TEXT NOT NULL,
			UNIQUE(issue_id, kind, sequence)
		)`,
		`CREATE INDEX IF NOT EXISTS evidence_records_issue ON evidence_records(issue_id, kind, sequence)`,
		`CREATE TABLE IF NOT EXISTS evidence_requests (
			scope TEXT NOT NULL,
			request_id TEXT NOT NULL,
			request_digest TEXT NOT NULL,
			response_json TEXT NOT NULL,
			PRIMARY KEY(scope, request_id)
		)`,
		`CREATE TABLE IF NOT EXISTS workspaces (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			local_path TEXT NOT NULL,
			baseline TEXT NOT NULL,
			context_summary TEXT NOT NULL,
			accepted_count INTEGER NOT NULL,
			resolved_count INTEGER NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS devices (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			status TEXT NOT NULL,
			last_seen_label TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// Soft removal: a tombstoned device keeps its history rows but daemon
		// (re)registration is refused, so a reconnecting worker cannot make it
		// reappear in the available device list.
		`CREATE TABLE IF NOT EXISTS removed_devices (
			device_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			removed_at TEXT NOT NULL
		)`,
		// A workspace the person deleted from a device: that device's reports
		// of it are ignored until the person adds the folder there again.
		`CREATE TABLE IF NOT EXISTS deleted_workspaces (
			workspace_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			local_path TEXT NOT NULL,
			deleted_at TEXT NOT NULL,
			PRIMARY KEY (workspace_id, device_id)
		)`,
		`CREATE TABLE IF NOT EXISTS workspace_display_names (
			workspace_id TEXT PRIMARY KEY,
			name TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS device_display_names (
			device_id TEXT PRIMARY KEY,
			name TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS provider_health (
			provider TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			auth_mode TEXT NOT NULL,
			secret_stored TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agent_profiles (
			id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			runtime TEXT NOT NULL,
			status TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (device_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS agents (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			status TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS workspace_files (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			path TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS issues (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL DEFAULT '',
			short_id TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			priority TEXT NOT NULL,
			runtime TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS runs (
			id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			runtime TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS run_events (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			level TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agent_sessions (
			id TEXT PRIMARY KEY,
			thread_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			status TEXT NOT NULL,
			parent_session_id TEXT NOT NULL DEFAULT '',
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agent_session_events (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			level TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS acceptance_artifacts (
			id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS chat_titles (
			workspace_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			title TEXT NOT NULL,
			version TEXT NOT NULL,
			generation_session_id TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (workspace_id, chat_id)
		)`,
		`CREATE TABLE IF NOT EXISTS chat_layouts (
			workspace_id TEXT PRIMARY KEY,
			revision INTEGER NOT NULL,
			payload_json TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS chat_deletions (
			workspace_id TEXT NOT NULL,
			deletion_key TEXT NOT NULL,
			PRIMARY KEY (workspace_id, deletion_key)
		)`,
		`CREATE TABLE IF NOT EXISTS chats (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS assets (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS skills (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			name TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS secret_records (
			id TEXT PRIMARY KEY,
			aad TEXT NOT NULL,
			ciphertext BLOB NOT NULL,
			wrapped_dek BLOB NOT NULL,
			dek_nonce BLOB NOT NULL,
			ct_nonce BLOB NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS secret_store_meta (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			canary_ciphertext BLOB NOT NULL,
			canary_wrapped_dek BLOB NOT NULL,
			canary_dek_nonce BLOB NOT NULL,
			canary_ct_nonce BLOB NOT NULL,
			kek_fingerprint TEXT NOT NULL,
			initialized_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// Bearer tokens for the session-scoped MCP/CLI surface. Each dispatch
		// mints one; a session's tokens stay valid while it is active and
		// until a day after their last use (session_tokens.go). Only SHA-256
		// hashes are stored; plaintext rides run_session to the daemon.
		// It replaces agent_session_tokens, which kept one token per turn.
		`DROP TABLE IF EXISTS agent_session_tokens`,
		`CREATE TABLE IF NOT EXISTS session_tokens (
			token_hash TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_used_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_session_tokens_session ON session_tokens (session_id)`,
		// The highest issue number ever handed out. Issue numbers never come
		// back: a worker names candidate branches and folders after them.
		`CREATE TABLE IF NOT EXISTS issue_sequence (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			last_number INTEGER NOT NULL
		)`,
	}
}
