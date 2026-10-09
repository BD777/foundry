package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// defaultSkillStore is the store capability behind default skill sets: the
// library skills a person gives every workspace they own.
type defaultSkillStore interface {
	ListUserDefaultSkills(ctx context.Context, userID string) ([]string, error)
	SetUserDefaultSkills(ctx context.Context, userID string, skillIDs []string) error
	ResolveDefaultSkills(ctx context.Context, workspaceID string) ([]store.SessionSkillRef, error)
}

func (s *Server) defaultSkills(w http.ResponseWriter) (defaultSkillStore, bool) {
	defaults, ok := s.store.(defaultSkillStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "default skills are not supported by this store")
	}
	return defaults, ok
}

func accountID(r *http.Request) string {
	if account := actorFromContext(r.Context()).Account; account != nil {
		return account.ID
	}
	return ""
}

// myDefaults answers a person's default skills and bundles.
func (s *Server) myDefaults(ctx context.Context, defaults defaultSkillStore, user string) (map[string]any, error) {
	ids, err := defaults.ListUserDefaultSkills(ctx, user)
	if err != nil {
		return nil, err
	}
	bundleIDs := []string{}
	if bundles, ok := s.store.(bundleStore); ok {
		if bundleIDs, err = bundles.ListBundleSelection(ctx, bundleScopeUser, user); err != nil {
			return nil, err
		}
	}
	return map[string]any{"skillIds": ids, "bundleIds": bundleIDs}, nil
}

func (s *Server) handleListMyDefaultSkills(w http.ResponseWriter, r *http.Request) {
	defaults, ok := s.defaultSkills(w)
	if !ok {
		return
	}
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "default skills belong to a signed-in account")
		return
	}
	result, err := s.myDefaults(r.Context(), defaults, user)
	writeResult(w, result, err)
}

func (s *Server) handleSetMyDefaultSkills(w http.ResponseWriter, r *http.Request) {
	var input struct {
		SkillIDs []string `json:"skillIds"`
		// BundleIDs, when sent, replaces the default bundles too.
		BundleIDs *[]string `json:"bundleIds"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	defaults, ok := s.defaultSkills(w)
	if !ok {
		return
	}
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "default skills belong to a signed-in account")
		return
	}
	if err := defaults.SetUserDefaultSkills(r.Context(), user, input.SkillIDs); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if bundles, ok := s.store.(bundleStore); ok && input.BundleIDs != nil {
		if err := bundles.SetBundleSelection(r.Context(), bundleScopeUser, user, *input.BundleIDs); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	s.invalidateProjections()
	result, err := s.myDefaults(r.Context(), defaults, user)
	writeResult(w, result, err)
}

// workspaceSkillSources is what a workspace's sessions get and where each
// skill comes from.
type workspaceSkillSources struct {
	// Refs: one skill per name, in this order of precedence: its selected
	// skills, its selected bundles, its owner's default skills, its owner's
	// default bundles; skills the workspace turned off are left out.
	Refs []store.SessionSkillRef
	// DefaultIDs: the refs that come from the owner's defaults.
	DefaultIDs []string
	// InheritedIDs: skills from defaults or bundles, turned off or not;
	// OffIDs: the ones the workspace turned off.
	InheritedIDs []string
	OffIDs       []string
}

// skillExclusionStore is the store capability behind turning off, in one
// workspace, skills its defaults or bundles give it.
type skillExclusionStore interface {
	ListWorkspaceSkillExclusions(ctx context.Context, workspaceID string) ([]string, error)
}

func resolveWorkspaceSkills(ctx context.Context, db store.Store, workspaceID string) (workspaceSkillSources, error) {
	var sources workspaceSkillSources
	refs, err := db.ResolveSessionSkills(ctx, workspaceID)
	if err != nil {
		return sources, err
	}
	bundled, defaultBundled, err := workspaceBundleRefs(ctx, db, workspaceID)
	if err != nil {
		return sources, err
	}
	var defaultSkills []store.SessionSkillRef
	if defaults, ok := db.(defaultSkillStore); ok {
		if defaultSkills, err = defaults.ResolveDefaultSkills(ctx, workspaceID); err != nil {
			return sources, err
		}
	}
	off := map[string]bool{}
	if exclusions, ok := db.(skillExclusionStore); ok {
		ids, err := exclusions.ListWorkspaceSkillExclusions(ctx, workspaceID)
		if err != nil {
			return sources, err
		}
		for _, id := range ids {
			off[id] = true
		}
	}
	names := map[string]bool{}
	for _, ref := range refs {
		names[strings.ToLower(ref.Name)] = true
	}
	add := func(extra []store.SessionSkillRef, isDefault bool) {
		for _, ref := range extra {
			if names[strings.ToLower(ref.Name)] {
				continue
			}
			sources.InheritedIDs = append(sources.InheritedIDs, ref.SkillID)
			if off[ref.SkillID] {
				sources.OffIDs = append(sources.OffIDs, ref.SkillID)
				continue
			}
			names[strings.ToLower(ref.Name)] = true
			refs = append(refs, ref)
			if isDefault {
				sources.DefaultIDs = append(sources.DefaultIDs, ref.SkillID)
			}
		}
	}
	add(bundled, false)
	add(defaultSkills, true)
	add(defaultBundled, true)
	sources.Refs = refs
	return sources, nil
}

// workspaceSkillRefs is everything a workspace's sessions get (see
// workspaceSkillSources.Refs) and the ones from its owner's defaults.
func workspaceSkillRefs(ctx context.Context, db store.Store, workspaceID string) ([]store.SessionSkillRef, []string, error) {
	sources, err := resolveWorkspaceSkills(ctx, db, workspaceID)
	return sources.Refs, sources.DefaultIDs, err
}

// sessionSkillRefs is everything a session on this workspace gets: its
// skills, then Foundry's built-in skills for the session's agent.
func sessionSkillRefs(ctx context.Context, db store.Store, workspaceID string, runtime string) ([]store.SessionSkillRef, error) {
	refs, _, err := workspaceSkillRefs(ctx, db, workspaceID)
	if err != nil {
		return nil, err
	}
	return withBuiltinSkills(refs, runtime), nil
}
