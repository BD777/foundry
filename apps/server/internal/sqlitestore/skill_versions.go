package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupSkillVersions(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS skill_revision_index (skill_id TEXT NOT NULL, revision INTEGER NOT NULL, source_digest TEXT NOT NULL DEFAULT '', manifest_json TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', PRIMARY KEY(skill_id,revision))`,
		`CREATE TABLE IF NOT EXISTS skill_sources (device_id TEXT NOT NULL, root TEXT NOT NULL, dir_name TEXT NOT NULL, skill_id TEXT NOT NULL, source_digest TEXT NOT NULL DEFAULT '', content_digest TEXT NOT NULL DEFAULT '', PRIMARY KEY(device_id,root,dir_name))`,
		`CREATE INDEX IF NOT EXISTS idx_skill_sources_id ON skill_sources(skill_id)`,
		`CREATE TABLE IF NOT EXISTS skill_version_migrations (id INTEGER PRIMARY KEY)`,
		`INSERT OR IGNORE INTO skill_sources(device_id,root,dir_name,skill_id) SELECT origin_device_id,origin_root,origin_dir_name,id FROM promoted_skills WHERE NOT EXISTS(SELECT 1 FROM skill_version_migrations WHERE id=1)`,
		`INSERT OR IGNORE INTO skill_version_migrations(id) VALUES(1)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	if err := s.ensureColumn(ctx, "device_skills", "manifest_json", `ALTER TABLE device_skills ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '[]'`); err != nil {
		return err
	}
	// Index legacy latest revisions once at startup, not during list/filter/preview.
	rows, err := s.conn().QueryContext(ctx, `SELECT p.id,p.latest_revision FROM promoted_skills p LEFT JOIN skill_revision_index i ON i.skill_id=p.id AND i.revision=p.latest_revision WHERE i.skill_id IS NULL OR i.error='zip: checksum error'`)
	if err != nil {
		return err
	}
	type ref struct {
		id       string
		revision int
	}
	refs := []ref{}
	for rows.Next() {
		var r ref
		if err = rows.Scan(&r.id, &r.revision); err != nil {
			rows.Close()
			return err
		}
		refs = append(refs, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, r := range refs {
		pkg, err := s.GetSkillPackage(ctx, r.id, r.revision)
		if err != nil {
			return err
		}
		idx, indexErr := skillarchive.InspectStored(pkg.Content, pkg.Checksum)
		if err = s.saveSkillIndex(ctx, r.id, r.revision, idx, indexErr); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) saveSkillIndex(ctx context.Context, id string, revision int, idx skillarchive.Index, indexErr error) error {
	raw, _ := json.Marshal(idx.Files)
	message := ""
	if indexErr != nil {
		message = indexErr.Error()
	}
	_, err := s.conn().ExecContext(ctx, `INSERT OR REPLACE INTO skill_revision_index(skill_id,revision,source_digest,manifest_json,error) VALUES(?,?,?,?,?)`, id, revision, idx.SourceDigest, string(raw), message)
	return err
}
func (s *Store) GetSkillRevisionIndex(ctx context.Context, id string, revision int) (store.SkillRevisionIndex, error) {
	var idx store.SkillRevisionIndex
	var raw, message string
	err := s.conn().QueryRowContext(ctx, `SELECT source_digest,manifest_json,error FROM skill_revision_index WHERE skill_id=? AND revision=?`, id, revision).Scan(&idx.SourceDigest, &raw, &message)
	if err == sql.ErrNoRows || (err == nil && message == "zip: checksum error") {
		pkg, err := s.GetSkillPackage(ctx, id, revision)
		if err != nil {
			return idx, err
		}
		idx, indexErr := skillarchive.InspectStored(pkg.Content, pkg.Checksum)
		if err = s.saveSkillIndex(ctx, id, pkg.Revision, idx, indexErr); err != nil {
			return idx, err
		}
		return idx, indexErr
	}
	if err != nil {
		return idx, err
	}
	if message != "" {
		return idx, fmt.Errorf("cannot compare this revision: %s", message)
	}
	err = json.Unmarshal([]byte(raw), &idx.Files)
	return idx, err
}
func (s *Store) GetDeviceSkillIndex(ctx context.Context, device, root, dir string) (store.SkillRevisionIndex, error) {
	var raw string
	var idx store.SkillRevisionIndex
	if err := s.conn().QueryRowContext(ctx, `SELECT source_digest,manifest_json FROM device_skills WHERE device_id=? AND root=? AND dir_name=?`, device, root, dir).Scan(&idx.SourceDigest, &raw); err != nil {
		return idx, err
	}
	if err := json.Unmarshal([]byte(raw), &idx.Files); err != nil {
		return idx, err
	}
	if len(idx.Files) == 0 {
		return idx, fmt.Errorf("update this device worker and run Scan now to index the local files")
	}
	return idx, nil
}

func (s *Store) enrichSkillStates(ctx context.Context, skills []store.DeviceSkill) error {
	catalog, err := s.ListPromotedSkills(ctx)
	if err != nil {
		return err
	}
	byID := map[string]store.PromotedSkill{}
	byName := map[string][]store.PromotedSkill{}
	for _, c := range catalog {
		byID[c.ID] = c
		byName[strings.ToLower(c.Name)] = append(byName[strings.ToLower(c.Name)], c)
	}
	type binding struct{ id, source, content string }
	bindings := map[string]binding{}
	rows, err := s.conn().QueryContext(ctx, `SELECT device_id,root,dir_name,skill_id,source_digest,content_digest FROM skill_sources`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var device, root, dir string
		var b binding
		if err = rows.Scan(&device, &root, &dir, &b.id, &b.source, &b.content); err != nil {
			rows.Close()
			return err
		}
		bindings[device+"\x00"+root+"\x00"+dir] = b
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for i := range skills {
		s := &skills[i]
		s.ServerState = "unpublished"
		s.ServerCandidates = byName[strings.ToLower(s.Name)]
		b := bindings[s.DeviceID+"\x00"+s.Root+"\x00"+s.DirName]
		if b.id != "" {
			s.PromotedSkillID = b.id
		}
		if c, ok := byID[s.PromotedSkillID]; ok {
			s.ServerRevision = c.LatestRevision
			found := false
			for _, v := range s.ServerCandidates {
				if v.ID == c.ID {
					found = true
				}
			}
			if !found {
				s.ServerCandidates = append([]store.PromotedSkill{c}, s.ServerCandidates...)
			}
			if s.SourceDigest == "" || c.SourceDigest == "" {
				s.ServerState = "unknown"
			} else if s.SourceDigest == c.SourceDigest || (s.SourceDigest == b.source && b.content == c.SourceDigest) {
				s.ServerState = "in_sync"
			} else {
				s.ServerState = "different"
			}
		} else if len(s.ServerCandidates) > 0 {
			s.ServerState = "name_conflict"
			for _, c := range s.ServerCandidates {
				if c.SourceDigest == "" || s.SourceDigest == "" {
					s.ServerState = "unknown"
				}
				if c.SourceDigest != "" && c.SourceDigest == s.SourceDigest {
					s.ServerState = "reusable"
					break
				}
			}
		}
	}
	return nil
}
