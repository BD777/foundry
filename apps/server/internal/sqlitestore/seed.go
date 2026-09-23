package sqlitestore

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) seedDemo(ctx context.Context) error {
	var count int
	if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces`).Scan(&count); err != nil {
		return fmt.Errorf("count seed workspaces: %w", err)
	}
	if count > 0 {
		return nil
	}

	now := time.Now().UTC()

	workspace := store.WorkspaceProjection{
		ID:             "ws_atlas",
		Name:           "Atlas Web",
		LocalPath:      "/Users/you/workspaces/atlas",
		Baseline:       "main",
		ContextSummary: "Workspace context is authoritative. Skill packs carry reusable technique. Workers run locally and do not remember.",
		AcceptedCount:  128,
		ResolvedCount:  42,
	}
	if err := s.insertWorkspace(ctx, workspace, now); err != nil {
		return err
	}

	device := store.DeviceProjection{
		ID:            "dev_mbp",
		Label:         "MacBook Pro M4",
		Status:        "connected",
		LastSeenLabel: "online",
	}
	if err := s.insertDevice(ctx, device, now); err != nil {
		return err
	}

	for _, provider := range []store.ProviderHealth{
		{DeviceID: device.ID, Provider: "claude", Status: "healthy", AuthMode: "env", SecretStored: "local"},
		{DeviceID: device.ID, Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local"},
	} {
		if err := s.insertProviderHealth(ctx, provider, now); err != nil {
			return err
		}
	}

	for _, asset := range []store.AssetProjection{
		{ID: "asset_worktrees", WorkspaceID: workspace.ID, Name: "Worktree pool", Kind: "worktree_pool", Status: "available", Detail: "2 active · 4 available"},
		{ID: "asset_archive", WorkspaceID: workspace.ID, Name: "Artifact archive", Kind: "artifact_archive", Status: "available", Detail: "128 accepted increments"},
		{ID: "asset_ports", WorkspaceID: workspace.ID, Name: "Preview ports", Kind: "preview_ports", Status: "available", Detail: "4200–4210 · local"},
	} {
		if err := s.insertAsset(ctx, asset, now); err != nil {
			return err
		}
	}

	for _, chat := range []store.ChatThread{
		{
			ID:           "c1",
			Title:        "Does the workspace have its own context?",
			Preview:      "workspace vs. chat context",
			Readonly:     false,
			UpdatedLabel: "2d",
		},
		{
			ID:           "c2",
			Title:        "Brainstorm: a calmer landing surface",
			Preview:      "ideas for density + disclosure",
			Readonly:     false,
			UpdatedLabel: "3d",
		},
		{
			ID:           "c3",
			Title:        "Where should baseline compare live?",
			Preview:      "review surface vs. runs",
			Readonly:     false,
			UpdatedLabel: "5d",
		},
	} {
		if err := s.insertChat(ctx, chat, now); err != nil {
			return err
		}
	}

	for _, issue := range seedIssues() {
		if issue.WorkspaceID == "" {
			issue.WorkspaceID = workspace.ID
		}
		if issue.Run != nil && issue.Run.WorkspaceID == "" {
			issue.Run.WorkspaceID = workspace.ID
		}
		if err := s.saveIssue(ctx, issue, now, now); err != nil {
			return err
		}
		if issue.Run != nil {
			if err := s.insertRun(ctx, *issue.Run, now); err != nil {
				return err
			}
			for _, event := range issue.Run.Events {
				if err := s.insertRunEvent(ctx, event, now); err != nil {
					return err
				}
			}
		}
		if issue.Artifact != nil {
			if err := s.insertArtifact(ctx, *issue.Artifact, now); err != nil {
				return err
			}
		}
	}

	return nil
}

func (s *Store) ResetDemo(ctx context.Context) error {
	tables := []string{
		"chat_deletions",
		"chat_layouts",
		"acceptance_artifacts",
		"agent_session_events",
		"agent_sessions",
		"run_events",
		"runs",
		"issues",
		"workspace_files",
		"agents",
		"agent_profiles",
		"assets",
		"skills",
		"chats",
		"provider_health",
		"devices",
		"workspaces",
	}
	for _, table := range tables {
		if _, err := s.conn().ExecContext(ctx, `DELETE FROM `+table); err != nil {
			return fmt.Errorf("reset %s: %w", table, err)
		}
	}
	return s.seedDemo(ctx)
}

func seedIssues() []store.Issue {
	return []store.Issue{
		{
			ID:                 "iss_112",
			ShortID:            "ISS-112",
			Title:              "Clarify which build is actually live",
			Status:             "pending",
			Priority:           "none",
			Readiness:          "direction",
			SourceInput:        `Pasted feedback: "I could not tell which build was actually live."`,
			InferredTask:       `Pasted feedback: "I could not tell which build was actually live."`,
			Runtime:            "mock",
			Skills:             []store.SkillPackRef{{ID: "issue-splitting", Name: "issue-splitting", Version: "1.0"}},
			AcceptanceCriteria: []string{"Clarify the feedback before production starts."},
			Checks:             []string{"Needs human direction"},
			UpdatedLabel:       "Updated 40m",
		},
		{
			ID:                 "iss_110",
			ShortID:            "ISS-110",
			Title:              "iOS simulator validation for the mobile shell",
			Status:             "pending",
			Priority:           "low",
			Readiness:          "unsuitable",
			SourceInput:        "Try iOS simulator validation for the mobile shell before acceptance.",
			InferredTask:       "Try iOS simulator validation for the mobile shell before acceptance.",
			Runtime:            "mock",
			Skills:             []store.SkillPackRef{},
			AcceptanceCriteria: []string{"Confirm the iOS simulator asset exists before dispatch."},
			Checks:             []string{"Requires iOS Simulator asset"},
			UpdatedLabel:       "Updated 1h",
		},
		{
			ID:                 "iss_108",
			ShortID:            "ISS-108",
			Title:              "Explain that secrets stay local on setup",
			Status:             "pending",
			Priority:           "medium",
			Readiness:          "ready",
			SourceInput:        "The provider setup page should explain that secrets stay on the device.",
			InferredTask:       "The provider setup page should explain that secrets stay on the device.",
			Runtime:            "claude",
			Skills:             []store.SkillPackRef{{ID: "issue-splitting", Name: "issue-splitting", Version: "1.0"}},
			AcceptanceCriteria: []string{"Setup copy states that credentials stay local."},
			Checks:             []string{"Ready to execute"},
			UpdatedLabel:       "Updated 18m",
		},
		{
			ID:                 "iss_107",
			ShortID:            "ISS-107",
			Title:              "Declutter the dashboard top-right cluster",
			Status:             "pending",
			Priority:           "medium",
			Readiness:          "split",
			SourceInput:        "Circled the crowded cluster in the top-right of the dashboard.",
			InferredTask:       "Circled the crowded cluster in the top-right of the dashboard.",
			Runtime:            "codex",
			Skills:             []store.SkillPackRef{{ID: "issue-splitting", Name: "issue-splitting", Version: "1.0"}},
			AcceptanceCriteria: []string{"Split the visual cleanup into executable sub-issues."},
			Checks:             []string{"Needs split"},
			UpdatedLabel:       "Updated 25m",
		},
		{
			ID:           "iss_105",
			ShortID:      "ISS-105",
			Title:        "Add baseline comparison to the review view",
			Status:       "verifying",
			Priority:     "high",
			SourceInput:  "Add a baseline comparison panel to the review surface.",
			InferredTask: "Add a baseline-vs-candidate comparison panel to the review surface, reusing the local preview host with changed-region highlighting.",
			Runtime:      "codex",
			Skills: []store.SkillPackRef{
				{ID: "baseline-comparison", Name: "baseline-comparison", Version: "1.2"},
				{ID: "visual-qa", Name: "visual-qa", Version: "0.9"},
			},
			AcceptanceCriteria: []string{
				"Review state exposes one primary acceptance artifact.",
				"Baseline and candidate metadata are visible.",
				"Accept and request-changes actions are present.",
			},
			Checks: []string{"Typecheck passed", "Visual smoke passed", "A11y contrast passed"},
			Artifact: &store.AcceptanceArtifact{
				ID:      "art_105",
				IssueID: "iss_105",
				Kind:    "preview",
				Title:   "Local Vite preview",
				Summary: "Candidate worktree wt-3 compared against baseline main.",
			},
			Run: &store.Run{
				ID:           "run_2411",
				IssueID:      "iss_105",
				Status:       "completed",
				Runtime:      "codex",
				StartedLabel: "2m ago",
				Events: []store.RunEvent{
					{ID: "evt_1", RunID: "run_2411", At: "2m ago", Label: "Loaded workspace context", Detail: "AGENTS.md, CONTEXT.md, and installed skills", Level: "info"},
					{ID: "evt_2", RunID: "run_2411", At: "90s ago", Label: "Produced acceptance artifact", Detail: "Local preview and comparison notes", Level: "info"},
				},
			},
			UpdatedLabel: "Updated 8m",
		},
		{
			ID:           "iss_104",
			ShortID:      "ISS-104",
			Title:        "Calm down workspace home density",
			Status:       "in_progress",
			Priority:     "high",
			SourceInput:  "The dashboard first screen feels busy. Make it calmer and move run logs behind details.",
			InferredTask: "Reduce visual density on the landing surface and move run logs behind progressive disclosure, keeping review and baseline prominent.",
			Runtime:      "claude",
			Skills:       []store.SkillPackRef{{ID: "shadcn-ui-cleanup", Name: "shadcn-ui-cleanup", Version: "0.4"}},
			AcceptanceCriteria: []string{
				"Workspace home keeps input and review surfaces prominent.",
				"Run logs are progressively disclosed.",
				"Layout remains scan-friendly.",
			},
			Checks: []string{"Typecheck running", "Visual QA queued"},
			Run: &store.Run{
				ID:           "run_2418",
				IssueID:      "iss_104",
				Status:       "running",
				Runtime:      "claude",
				StartedLabel: "45s ago",
				Events: []store.RunEvent{
					{ID: "evt_2418_1", RunID: "run_2418", At: "2m 14s", Label: "Dispatched to MacBook Pro M4", Detail: "worktree wt-3 allocated", Level: "info"},
					{ID: "evt_2418_2", RunID: "run_2418", At: "2m 06s", Label: "Claude started", Detail: "loaded AGENTS.md + workspace context", Level: "info"},
					{ID: "evt_2418_3", RunID: "run_2418", At: "1m 40s", Label: "Edited src/workspace/Home.tsx", Detail: "reduced density, moved logs behind details", Level: "info"},
					{ID: "evt_2418_4", RunID: "run_2418", At: "1m 02s", Label: "Permission requested - pnpm typecheck", Detail: "granted by workspace policy", Level: "info"},
					{ID: "evt_2418_5", RunID: "run_2418", At: "0m 44s", Label: "Typecheck passed", Detail: "0 errors reported", Level: "info"},
					{ID: "evt_2418_6", RunID: "run_2418", At: "now", Label: "Building review preview", Detail: "vite build -> local preview", Level: "info"},
				},
			},
			UpdatedLabel: "Updated 2m",
		},
		{
			ID:           "iss_106",
			ShortID:      "ISS-106",
			Title:        "Extract shared status chip component",
			Status:       "in_progress",
			Priority:     "medium",
			SourceInput:  "Reuse one status chip across acceptance, runs, and issues.",
			InferredTask: "Extract the shared status chip surface so issue cards, run rows, and acceptance panels render one consistent state language.",
			Runtime:      "codex",
			Skills:       []store.SkillPackRef{{ID: "shadcn-ui-cleanup", Name: "shadcn-ui-cleanup", Version: "0.4"}},
			AcceptanceCriteria: []string{
				"Status tone, dot, and label rendering come from one component.",
				"Issue, run, and review states keep matching colors.",
				"No page-specific chip styling duplicates remain.",
			},
			Checks: []string{"Component extraction running", "Visual QA queued"},
			Run: &store.Run{
				ID:           "run_2417",
				IssueID:      "iss_106",
				Status:       "running",
				Runtime:      "codex",
				StartedLabel: "46s ago",
				Events: []store.RunEvent{
					{ID: "evt_4", RunID: "run_2417", At: "46s ago", Label: "Editing shared component", Detail: "Normalizing issue, run, and acceptance chip states", Level: "info"},
				},
			},
			UpdatedLabel: "Updated 46s",
		},
		{
			ID:                 "iss_118",
			ShortID:            "ISS-118",
			Title:              "Tighten run timeline row spacing",
			Status:             "verifying",
			Priority:           "medium",
			SourceInput:        "Row spacing on the run timeline feels loose — tighten it.",
			InferredTask:       "Tighten vertical spacing on run-timeline rows without breaking the existing hierarchy.",
			Runtime:            "claude",
			Skills:             []store.SkillPackRef{{ID: "visual-qa", Name: "visual-qa", Version: "0.9"}},
			AcceptanceCriteria: []string{"Run timeline rows are denser while retaining hierarchy."},
			Checks:             []string{"1 check needs attention"},
			Artifact: &store.AcceptanceArtifact{
				ID:      "art_118",
				IssueID: "iss_118",
				Kind:    "preview",
				Title:   "Timeline spacing preview",
				Summary: "Candidate run timeline spacing compared against the baseline.",
			},
			UpdatedLabel: "Updated 31m",
		},
		{
			ID:                 "iss_201",
			ShortID:            "ISS-201",
			Title:              "Provider settings copy",
			Status:             "accepted",
			Priority:           "low",
			SourceInput:        "Rewrite provider settings to emphasize that secrets stay local.",
			InferredTask:       "Rewrite provider settings to emphasize that secrets stay local.",
			Runtime:            "claude",
			Skills:             []store.SkillPackRef{{ID: "web-preview-acceptance", Name: "web-preview-acceptance", Version: "2.0"}},
			AcceptanceCriteria: []string{"Provider settings copy emphasizes local credentials."},
			Checks:             []string{"Baseline updated"},
			UpdatedLabel:       "Updated 12m",
		},
		{
			ID:                 "iss_098",
			ShortID:            "ISS-098",
			Title:              "Compact run timeline",
			Status:             "accepted",
			Priority:           "medium",
			SourceInput:        "Denser run timeline rows for scanning.",
			InferredTask:       "Denser run timeline rows for scanning.",
			Runtime:            "codex",
			Skills:             []store.SkillPackRef{{ID: "web-preview-acceptance", Name: "web-preview-acceptance", Version: "2.0"}},
			AcceptanceCriteria: []string{"Run timeline rows scan more densely."},
			Checks:             []string{"Baseline updated"},
			UpdatedLabel:       "Updated 3h",
		},
	}
}

func (s *Store) insertWorkspace(ctx context.Context, value store.WorkspaceProjection, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO workspaces
		(id, name, local_path, baseline, context_summary, accepted_count, resolved_count, payload_json, updated_at, device_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		value.ID, value.Name, value.LocalPath, value.Baseline, value.ContextSummary, value.AcceptedCount, value.ResolvedCount, payload, formatTime(now), value.DeviceID)
	return err
}

func (s *Store) insertDevice(ctx context.Context, value store.DeviceProjection, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?)`,
		value.ID, value.Label, value.Status, value.LastSeenLabel, payload, formatTime(now))
	return err
}

func (s *Store) insertProviderHealth(ctx context.Context, value store.ProviderHealth, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO provider_health VALUES (?, ?, ?, ?, ?, ?)`,
		value.Provider, value.Status, value.AuthMode, value.SecretStored, payload, formatTime(now))
	return err
}

func (s *Store) insertAsset(ctx context.Context, value store.AssetProjection, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO assets (id, workspace_id, name, kind, status, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		value.ID, value.WorkspaceID, value.Name, value.Kind, value.Status, payload, formatTime(now))
	return err
}

func (s *Store) insertChat(ctx context.Context, value store.ChatThread, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO chats VALUES (?, ?, ?, ?)`,
		value.ID, value.Title, payload, formatTime(now))
	return err
}

func (s *Store) insertRun(ctx context.Context, value store.Run, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO runs (id, issue_id, workspace_id, status, runtime, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		value.ID, value.IssueID, value.WorkspaceID, value.Status, value.Runtime, payload, formatTime(now))
	return err
}

func (s *Store) insertRunEvent(ctx context.Context, value store.RunEvent, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO run_events VALUES (?, ?, ?, ?, ?)`,
		value.ID, value.RunID, value.Level, payload, formatTime(now))
	return err
}

func (s *Store) insertArtifact(ctx context.Context, value store.AcceptanceArtifact, now time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO acceptance_artifacts VALUES (?, ?, ?, ?, ?)`,
		value.ID, value.IssueID, value.Kind, payload, formatTime(now))
	return err
}
