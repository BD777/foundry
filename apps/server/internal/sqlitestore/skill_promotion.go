package sqlitestore

import (
	"context"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Prepare archives outside the transaction; catalog writes and source bindings
// are atomic and guarded by the exact server revisions reviewed by the user.
func (s *Store) PromoteSkillPackages(ctx context.Context, packages []store.SkillPromotionPackage) ([]store.PromotedSkill, error) {
	type prepared struct {
		pkg    store.SkillPromotionPackage
		idx    skillarchive.Index
		target store.PromotedSkill
		name   string
	}
	ready := []prepared{}
	for _, pkg := range packages {
		r := pkg.Resolution
		if r.Action == "" {
			r = store.DefaultSkillResolution(pkg.Source)
		}
		pkg.Resolution = r
		p := prepared{pkg: pkg, name: pkg.Source.Name}
		switch r.Action {
		case "update", "reuse":
			target, err := s.GetPromotedSkill(ctx, r.TargetSkillID)
			if err != nil {
				return nil, err
			}
			p.target = target
			p.name = target.Name
			if r.ExpectedRevision <= 0 || r.ExpectedRevision != target.LatestRevision {
				return nil, skillConflict("server revision changed; reopen the promotion preview")
			}
			if !strings.EqualFold(target.Name, pkg.Source.Name) && pkg.Source.PromotedSkillID != target.ID {
				return nil, skillConflict("selected server skill has a different invocation name")
			}
			if r.Action == "reuse" {
				if target.SourceDigest == "" {
					return nil, skillConflict("server comparison index is unavailable")
				}
				if pkg.Source.SourceDigest != target.SourceDigest && !(pkg.Source.PromotedSkillID == target.ID && pkg.Source.ServerState == "in_sync") {
					return nil, skillConflict("only identical content can be reused")
				}
				ready = append(ready, p)
				continue
			}
		case "fork":
			p.name = strings.TrimSpace(r.Name)
			if !skillarchive.ValidInvocationName(p.name) {
				return nil, skillConflict("fork name must be 1–64 lowercase letters, numbers or hyphens")
			}
			if p.name == pkg.Source.Name {
				return nil, skillConflict("fork needs a distinct invocation name")
			}
		case "create":
		default:
			return nil, skillConflict("choose how to resolve the same-name skill %s", pkg.Source.Name)
		}
		normalized, idx, err := skillarchive.PreparePromotion(pkg.Content, pkg.Source.SourceDigest)
		if err != nil {
			return nil, skillConflict("invalid package for %s: %v", pkg.Source.Name, err)
		}
		if idx.SourceDigest != pkg.Source.SourceDigest {
			return nil, skillConflict("skill contents changed; scan and review again")
		}
		p.pkg.Content = normalized
		if p.name != pkg.Source.Name {
			p.pkg.Content, err = skillarchive.Rename(normalized, p.name)
			if err != nil {
				return nil, err
			}
			idx, err = skillarchive.Inspect(p.pkg.Content)
			if err != nil {
				return nil, err
			}
		}
		p.idx = idx
		ready = append(ready, p)
	}
	intents := map[string]string{}
	for _, p := range ready {
		r := p.pkg.Resolution
		if r.TargetSkillID == "" {
			continue
		}
		digest := p.idx.SourceDigest
		if r.Action == "reuse" {
			digest = p.target.SourceDigest
		}
		if previous, ok := intents[r.TargetSkillID]; ok && previous != digest {
			return nil, skillConflict("the batch proposes different contents for the same server skill")
		}
		intents[r.TargetSkillID] = digest
	}
	result := []store.PromotedSkill{}
	err := s.withTx(ctx, func(tx *Store) error {
		// Check every target before writes, including aliases reusing the same entry.
		for _, p := range ready {
			r := p.pkg.Resolution
			if r.TargetSkillID != "" {
				current, err := tx.GetPromotedSkill(ctx, r.TargetSkillID)
				if err != nil {
					return err
				}
				if current.LatestRevision != r.ExpectedRevision {
					return skillConflict("server revision changed; reopen the promotion preview")
				}
			}
		}
		runtimeNames := map[string]string{}
		for _, p := range ready {
			source := p.pkg.Source
			r := p.pkg.Resolution
			var item store.PromotedSkill
			if r.Action == "reuse" {
				var err error
				item, err = tx.GetPromotedSkill(ctx, r.TargetSkillID)
				if err != nil {
					return err
				}
			} else {
				if r.Action == "create" || r.Action == "fork" {
					var count int
					if err := tx.conn().QueryRowContext(ctx, `SELECT count(*) FROM promoted_skills WHERE lower(name)=lower(?)`, p.name).Scan(&count); err != nil {
						return err
					}
					if count > 0 {
						return skillConflict("skill name %s is already on the server; review the conflict", p.name)
					}
				}
				input := store.PromoteSkillInput{DeviceID: source.DeviceID, Root: source.Root, DirName: source.DirName, TargetSkillID: r.TargetSkillID, ForceNew: r.Action == "create" || r.Action == "fork"}
				var err error
				item, _, err = tx.addPromotedSkillRevision(ctx, input, p.name, source.Description, p.pkg.Content, len(p.idx.Files), p.idx, nil)
				if err != nil {
					return err
				}
			}
			if previous, ok := runtimeNames[strings.ToLower(item.Name)]; ok && previous != item.ID {
				return skillConflict("promotion contains conflicting invocation name %s", item.Name)
			}
			runtimeNames[strings.ToLower(item.Name)] = item.ID
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO skill_sources(device_id,root,dir_name,skill_id,source_digest,content_digest) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,root,dir_name) DO UPDATE SET skill_id=excluded.skill_id,source_digest=excluded.source_digest,content_digest=excluded.content_digest`, source.DeviceID, source.Root, source.DirName, item.ID, source.SourceDigest, item.SourceDigest); err != nil {
				return err
			}
			result = append(result, item)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func skillConflict(format string, args ...any) error {
	return fmt.Errorf("%w: %s", store.ErrSkillVersionConflict, fmt.Sprintf(format, args...))
}
