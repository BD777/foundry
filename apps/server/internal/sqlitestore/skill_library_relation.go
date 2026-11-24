package sqlitestore

import (
	"context"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type librarySkillHistory struct {
	id     string
	latest int
	// When content recurs, report its most recent revision.
	matches map[string]int
	digests map[int]string
}
type librarySkillHistories struct {
	byID   map[string]*librarySkillHistory
	byName map[string][]*librarySkillHistory
}

func (s *Store) librarySkillHistories(ctx context.Context) (librarySkillHistories, error) {
	h := librarySkillHistories{map[string]*librarySkillHistory{}, map[string][]*librarySkillHistory{}}
	rows, err := s.reader().QueryContext(ctx, `SELECT p.id,p.name,p.latest_revision,COALESCE(i.revision,0),COALESCE(i.source_digest,'')
		FROM promoted_skills p LEFT JOIN skill_revision_index i ON i.skill_id=p.id AND i.error=''
		ORDER BY p.id,i.revision`)
	if err != nil {
		return h, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, digest string
		var latest, rev int
		if err := rows.Scan(&id, &name, &latest, &rev, &digest); err != nil {
			return h, err
		}
		item := h.byID[id]
		if item == nil {
			item = &librarySkillHistory{id: id, latest: latest, matches: map[string]int{}, digests: map[int]string{}}
			h.byID[id] = item
			key := strings.ToLower(name)
			h.byName[key] = append(h.byName[key], item)
		}
		if digest != "" {
			item.matches[digest] = rev
			item.digests[rev] = digest
		}
	}
	return h, rows.Err()
}

func (h librarySkillHistories) compare(name, digest, boundID string, base int) *store.SkillLibraryRelation {
	target := h.byID[boundID]
	if target == nil {
		base = 0
		for _, candidate := range h.byName[strings.ToLower(name)] {
			if target == nil || candidate.matches[digest] > 0 {
				target = candidate
				if candidate.matches[digest] > 0 {
					break
				}
			}
		}
	}
	if target == nil {
		return &store.SkillLibraryRelation{Status: "notInLibrary"}
	}
	if digest == "" {
		return nil
	}
	match := target.matches[digest]
	relation := &store.SkillLibraryRelation{SkillID: target.id, LatestRevision: target.latest, MatchedRevision: match, BaseRevision: base}
	switch {
	case base > 0 && base < target.latest && target.digests[base] != digest && match != target.latest:
		relation.Status = "diverged"
	case match > 0:
		relation.Status = "same"
	default:
		relation.Status = "differs"
	}
	return relation
}
