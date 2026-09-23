package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"net/http"
	"sort"
	"strings"

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
			required = required || included[dep.SkillName]
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

func (s *Server) storedSkillPromotionPlan(ctx context.Context, input store.PromoteSkillInput) (store.SkillPromotionPlan, error) {
	skills, err := s.store.ListDeviceSkills(ctx, input.DeviceID)
	if err != nil {
		return store.SkillPromotionPlan{}, err
	}
	plan := buildSkillPromotionPlan(input, skills)
	choices := []store.SkillPromotionResolution{}
	for _, source := range plan.Skills {
		r := store.ResolveSkillPromotion(source, input.Resolutions)
		choices = append(choices, r)
		if r.Action == "update" || r.Action == "reuse" {
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
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	plan, err := s.storedSkillPromotionPlan(r.Context(), input)
	writeResult(w, plan, err)
}

func (s *Server) promoteSkillClosure(w http.ResponseWriter, r *http.Request, input store.PromoteSkillInput) {
	plan, err := s.storedSkillPromotionPlan(r.Context(), input)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if len(plan.Problems) > 0 {
		writeError(w, http.StatusConflict, fmt.Sprintf("Cannot promote: %v", plan.Problems))
		return
	}
	// Legacy callers can publish a dependency-free skill. Multi-skill writes
	// always require the exact preview digest.
	needsReview := len(plan.Skills) > 1
	for _, source := range plan.Skills {
		r := store.ResolveSkillPromotion(source, input.Resolutions)
		if source.PromotedSkillID != "" || len(source.ServerCandidates) > 0 || r.Action == "fork" {
			needsReview = true
		}
	}
	if input.PlanDigest != plan.Digest && (input.PlanDigest != "" || needsReview) {
		writeError(w, http.StatusConflict, "Skill dependencies changed. Review the promotion plan again.")
		return
	}
	packages := []store.SkillPromotionPackage{}
	for _, source := range plan.Skills {
		resolution := store.ResolveSkillPromotion(source, input.Resolutions)
		if resolution.Action == "reuse" {
			packages = append(packages, store.SkillPromotionPackage{Source: source, Resolution: resolution})
			continue
		}
		content, err := s.hub.ReadDeviceSkillContent(r.Context(), input.DeviceID, source.Root, source.DirName)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		if content.Name != source.Name || content.SourceDigest != source.SourceDigest {
			writeError(w, http.StatusConflict, "Skill files changed since the last scan. Run Scan now and review again.")
			return
		}
		zip, err := base64.StdEncoding.DecodeString(content.ContentB64)
		if err != nil {
			writeError(w, http.StatusBadGateway, "Device returned malformed skill content")
			return
		}
		packages = append(packages, store.SkillPromotionPackage{Source: source, Content: zip, FileCount: content.FileCount, Resolution: resolution})
	}
	// A concurrent explicit scan may replace the saved graph. No filesystem
	// traversal here: each uploaded tree has already matched its source digest.
	check, err := s.storedSkillPromotionPlan(r.Context(), input)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if check.Digest != plan.Digest {
		writeError(w, http.StatusConflict, "Skills changed while packaging; review again")
		return
	}
	published, err := s.store.PromoteSkillPackages(r.Context(), packages)
	if err != nil {
		if errors.Is(err, store.ErrSkillVersionConflict) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	for i, item := range published {
		if packages[i].Source.Root == input.Root && packages[i].Source.DirName == input.DirName {
			writeResultWithStatus(w, http.StatusCreated, item, nil)
			return
		}
	}
}
