package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func skillSourceKey(s store.DeviceSkill) string { return s.Root + "\x00" + s.DirName }

// Identity is device/root/directory, never name alone. Ambiguity blocks the
// required closure rather than silently choosing a different installed version.
func buildSkillPromotionPlan(input store.PromoteSkillInput, skills []store.DeviceSkill) store.SkillPromotionPlan {
	plan := store.SkillPromotionPlan{Skills: []store.DeviceSkill{}, Problems: []string{}, Related: []store.SkillDependency{}}
	byKey := map[string]store.DeviceSkill{}
	for _, s := range skills {
		byKey[skillSourceKey(s)] = s
	}
	included := map[string]bool{}
	for _, name := range input.IncludeRelated {
		included[name] = true
	}
	seen := map[string]bool{}
	names := map[string]string{}
	var visit func(string)
	visit = func(key string) {
		if seen[key] {
			return
		}
		seen[key] = true
		s, ok := byKey[key]
		if !ok {
			plan.Problems = append(plan.Problems, "Skill source is missing; scan the device again")
			return
		}
		if other, exists := names[strings.ToLower(s.Name)]; exists && other != key {
			plan.Problems = append(plan.Problems, "Conflicting installed versions of "+s.Name)
			return
		}
		names[strings.ToLower(s.Name)] = key
		plan.Skills = append(plan.Skills, s)
		if (!s.DependenciesAnalyzed || s.SourceDigest == "") && s.DependencyAnalysisError == "" {
			plan.Problems = append(plan.Problems, s.Name+": run Scan now once to build the device dependency graph")
		}
		if s.DependencyAnalysisError != "" {
			plan.Problems = append(plan.Problems, s.Name+": "+s.DependencyAnalysisError)
		}
		if s.SizeBytes < 0 {
			plan.Problems = append(plan.Problems, s.Name+": package exceeds limits or is unreadable")
		}
		for _, dep := range s.Dependencies {
			required := dep.Strength == store.SkillDependencyRequired
			if !required {
				plan.Related = append(plan.Related, dep)
			}
			required = required || included[dep.SkillName] || input.IncludeAllRelated
			if !required {
				continue
			}
			if dep.Status != "resolved" || dep.TargetRoot == "" || dep.TargetDirName == "" {
				plan.Problems = append(plan.Problems, fmt.Sprintf("%s needs %s (%s): %s", s.Name, dep.SkillName, dep.Status, dep.Evidence))
				continue
			}
			visit(dep.TargetRoot + "\x00" + dep.TargetDirName)
		}
	}
	visit(input.Root + "\x00" + input.DirName)
	sort.Slice(plan.Skills, func(i, j int) bool { return skillSourceKey(plan.Skills[i]) < skillSourceKey(plan.Skills[j]) })
	sort.Strings(plan.Problems)
	raw, _ := json.Marshal(plan)
	digest := sha256.Sum256(raw)
	plan.Digest = hex.EncodeToString(digest[:])
	return plan
}

func (s *Server) storedSkillPromotionPlan(ctx context.Context, p *promotionSource) (store.SkillPromotionPlan, error) {
	input := p.input
	plan := buildSkillPromotionPlan(input, p.graph)
	choices := []store.SkillPromotionResolution{}
	for _, source := range plan.Skills {
		r := store.ResolveSkillPromotion(source, input.Resolutions)
		if input.ExpectedRevision != nil && source.Root == input.Root && source.DirName == input.DirName {
			latest := 0
			if source.LibraryRelation != nil {
				latest = source.LibraryRelation.LatestRevision
			}
			if r.TargetSkillID != "" {
				for _, c := range source.ServerCandidates {
					if c.ID == r.TargetSkillID {
						latest = c.LatestRevision
					}
				}
			}
			if latest != *input.ExpectedRevision {
				plan.Problems = append(plan.Problems, "Library revision changed; compare again before publishing.")
			}
			if r.Action == "" && len(source.ServerCandidates) == 1 && *input.ExpectedRevision == latest {
				r.Action = "update"
				r.TargetSkillID = source.ServerCandidates[0].ID
				r.ExpectedRevision = latest
				p.input.Resolutions = append(p.input.Resolutions, r)
			}
		}
		if source.Root == "library" && p.drafts != nil && r.Action != "reuse" {
			plan.Problems = append(plan.Problems, "A selected library dependency can only be reused")
		}
		if source.LibraryRelation != nil && source.LibraryRelation.Status == "diverged" && (!input.MergedLatest || r.Action != "update" || r.ExpectedRevision != source.LibraryRelation.LatestRevision || input.ExpectedRevision == nil) {
			plan.Problems = append(plan.Problems, source.Name+": merge the latest library revision and compare again before publishing.")
		}
		choices = append(choices, r)
		if r.Action == "update" || r.Action == "reuse" || r.Action == "keep" {
			found := false
			for _, candidate := range source.ServerCandidates {
				if candidate.ID == r.TargetSkillID && candidate.LatestRevision == r.ExpectedRevision {
					found = true
				}
			}
			if !found {
				plan.Problems = append(plan.Problems, "Server revision changed for "+source.Name+"; reopen the preview.")
			}
		}
		if r.Action == "create" && len(source.ServerCandidates) > 0 {
			plan.Problems = append(plan.Problems, "Choose how to resolve same-name skill "+source.Name)
		}
		if r.Action == "fork" {
			name := strings.TrimSpace(r.Name)
			if !skillarchive.ValidInvocationName(name) || name == source.Name {
				plan.Problems = append(plan.Problems, "Enter a distinct valid invocation name for "+source.Name)
			}
			catalog, err := s.store.ListPromotedSkills(ctx)
			if err != nil {
				return plan, err
			}
			for _, c := range catalog {
				if strings.EqualFold(c.Name, name) {
					plan.Problems = append(plan.Problems, "Invocation name already exists: "+name)
				}
			}
		}
		if r.Action == "" {
			plan.Problems = append(plan.Problems, "Choose how to resolve same-name skill "+source.Name)
		}
	}
	plan.Digest = ""
	raw, _ := json.Marshal(struct {
		Plan    store.SkillPromotionPlan
		Choices []store.SkillPromotionResolution
	}{plan, choices})
	sum := sha256.Sum256(raw)
	plan.Digest = hex.EncodeToString(sum[:])
	return plan, nil
}

func (s *Server) handleSkillPromotionPlan(w http.ResponseWriter, r *http.Request) {
	var input store.PromoteSkillInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	p, err := s.publicationSource(r.Context(), actorFromContext(r.Context()), input)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	plan, err := s.storedSkillPromotionPlan(r.Context(), &p)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.callerVisibility(r)
	plan.Skills = view.deviceSkillUsage(plan.Skills)
	writeResult(w, plan, err)
}

func (s *Server) handlePublishSkill(w http.ResponseWriter, r *http.Request) {
	var input store.PromoteSkillInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		writeError(w, http.StatusBadRequest, "expectedRevision is required (0 for a new skill)")
		return
	}
	s.promoteSkillClosure(w, r, input)
}

func (s *Server) promoteSkillClosure(w http.ResponseWriter, r *http.Request, input store.PromoteSkillInput) {
	p, err := s.publicationSource(r.Context(), actorFromContext(r.Context()), input)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	item, err := s.publishSkill(r.Context(), actorFromContext(r.Context()), input, p)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.callerVisibility(r)
	writeResultWithStatus(w, http.StatusCreated, view.skillUsage([]store.PromotedSkill{item})[0], err)
}

func (s *Server) publishSkill(ctx context.Context, actor Actor, request store.PromoteSkillInput, p promotionSource) (store.PromotedSkill, error) {
	var empty store.PromotedSkill
	plan, err := s.storedSkillPromotionPlan(ctx, &p)
	if err != nil {
		return empty, err
	}
	if len(plan.Problems) > 0 {
		return empty, conflict(fmt.Sprintf("Cannot publish: %v", plan.Problems))
	}
	input := p.input
	needsReview := len(plan.Skills) > 1
	for _, source := range plan.Skills {
		if input.ExpectedRevision == nil && (source.PromotedSkillID != "" || len(source.ServerCandidates) > 0 || store.ResolveSkillPromotion(source, input.Resolutions).Action == "fork") {
			needsReview = true
		}
	}
	if input.PlanDigest != plan.Digest && (input.PlanDigest != "" || needsReview) {
		return empty, conflict("Skill dependencies changed. Review the promotion plan again.")
	}
	packages := make([]store.SkillPromotionPackage, 0, len(plan.Skills))
	for _, source := range plan.Skills {
		resolution := store.ResolveSkillPromotion(source, input.Resolutions)
		pkg := store.SkillPromotionPackage{Source: source, Resolution: resolution, LibraryDependency: p.drafts != nil && source.Root == "library"}
		if p.drafts != nil && source.Root == input.SourceWorkspaceID {
			pkg.DraftWorkspaceID = input.SourceWorkspaceID
		}
		if resolution.Action != "reuse" && resolution.Action != "keep" {
			content, err := s.readPromotionSource(ctx, p, source)
			if err != nil {
				return empty, err
			}
			if content.Name != source.Name || content.SourceDigest != source.SourceDigest {
				return empty, conflict("Skill files changed since the last scan. Refresh and compare again.")
			}
			pkg.Content, err = base64.StdEncoding.DecodeString(content.ContentB64)
			if err != nil {
				return empty, &statusError{http.StatusBadGateway, errors.New("device returned malformed skill content")}
			}
			pkg.FileCount = content.FileCount
		}
		packages = append(packages, pkg)
	}
	again, err := s.publicationSource(ctx, actor, request)
	if err != nil {
		return empty, err
	}
	check, err := s.storedSkillPromotionPlan(ctx, &again)
	if err != nil {
		return empty, err
	}
	if check.Digest != plan.Digest {
		return empty, conflict("Skills changed while packaging; compare again")
	}
	published, err := s.store.PromoteSkillPackages(ctx, packages, input.WorkspaceID)
	if errors.Is(err, store.ErrSkillVersionConflict) {
		return empty, conflict(err.Error() + "; compare again")
	}
	if err != nil {
		return empty, err
	}
	s.projectionsChanged("", skillLibraryFields...)
	if input.WorkspaceID != "" {
		s.projectionsChanged(input.WorkspaceID, workspaceSkillFields...)
	}
	for i, item := range published {
		if packages[i].Source.Root == input.Root && packages[i].Source.DirName == input.DirName {
			return item, nil
		}
	}
	return empty, errors.New("published closure missing requested skill")
}
