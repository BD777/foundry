package sqlitestore

import (
	"context"
	"path"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) WorkspaceSkillCheckouts(ctx context.Context, workspaceID string) (map[string]store.SkillCheckoutBaseline, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT relative_path,skill_id,revision,directory_id FROM workspace_skill_checkouts WHERE workspace_id=?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byPath := make(map[string]store.SkillCheckoutBaseline)
	for rows.Next() {
		var path string
		var base store.SkillCheckoutBaseline
		if err = rows.Scan(&path, &base.SkillID, &base.Revision, &base.CheckoutDirectoryID); err != nil {
			return nil, err
		}
		byPath[path] = base
	}
	return byPath, rows.Err()
}

func (s *Store) SaveWorkspaceSkillCheckout(ctx context.Context, workspaceID, relativePath string, base store.SkillCheckoutBaseline) error {
	_, err := s.conn().ExecContext(ctx, `
    INSERT INTO workspace_skill_checkouts(workspace_id,relative_path,skill_id,revision,directory_id)
    VALUES(?,?,?,?,?)
    ON CONFLICT(workspace_id,relative_path) DO UPDATE SET
        skill_id=excluded.skill_id,
        revision=excluded.revision,
        directory_id=COALESCE(NULLIF(excluded.directory_id,''), workspace_skill_checkouts.directory_id)
    WHERE excluded.directory_id='' OR excluded.directory_id<>workspace_skill_checkouts.directory_id`, workspaceID, relativePath, base.SkillID, base.Revision, base.CheckoutDirectoryID)
	return err
}

// A complete root scan reconciles filesystem receipts with the database. A
// receipt for the same directory must not rewind the base advanced by publish.
func (s *Store) reconcileSkillCheckouts(ctx context.Context, workspaceID string, scan store.WorkspaceDraftSkills) error {
	previous, err := s.WorkspaceSkillCheckouts(ctx, workspaceID)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	unreadable := map[string]bool{}
	for _, draft := range scan.Skills {
		seen[draft.RelativePath] = true
		if draft.Status == "invalid" {
			unreadable[draft.RelativePath] = true
		}
		origin, ok := scan.CheckoutOrigins[draft.RelativePath]
		if !ok || origin.DirectoryID == "" || origin.SkillID == "" || origin.Revision < 1 {
			continue
		}
		if previous[draft.RelativePath].CheckoutDirectoryID == origin.DirectoryID {
			continue
		}
		base := origin.SkillCheckoutBaseline
		base.CheckoutDirectoryID = origin.DirectoryID
		if err := s.SaveWorkspaceSkillCheckout(ctx, workspaceID, draft.RelativePath, base); err != nil {
			return err
		}
	}
	for relative, base := range previous {
		_, hasReceipt := scan.CheckoutOrigins[relative]
		if unreadable[path.Dir(relative)] || (seen[relative] && (base.CheckoutDirectoryID == "" || hasReceipt)) {
			continue
		}
		if _, err := s.conn().ExecContext(ctx, `DELETE FROM workspace_skill_checkouts WHERE workspace_id=? AND relative_path=?`, workspaceID, relative); err != nil {
			return err
		}
	}
	return nil
}
