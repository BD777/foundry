package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/builtinskills"
	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"strings"
	"time"
)

func (s *Server) resolveSkillTrial(ctx context.Context, input store.CreateAgentSessionInput) (*store.ResolvedSkillSelection, error) {
	fail := func(message string) (*store.ResolvedSkillSelection, error) {
		return nil, &statusError{http.StatusBadRequest, errors.New(message)}
	}
	choice := input.SkillSelection
	if choice.Mode != "include" && choice.Mode != "exclude" {
		return fail("skillSelection.mode must be include or exclude")
	}
	if input.NativeSessionID != "" || input.ForkSessionID != "" || input.ChatID != "" || input.ImportedContext != "" || input.ProfileTransitionNote != "" {
		return fail("Skill trials require clean native history; fork, adoption and imported context are not allowed")
	}
	if len(choice.Drafts)+len(choice.Library)+len(choice.Names) > 100 {
		return fail("at most 100 Skill trial references")
	}
	backing, ok := s.store.(store.WorkspaceDraftStore)
	if !ok {
		return fail("Skill trials are unavailable")
	}
	agent, err := s.store.ResolveSessionAgent(ctx, input)
	if err != nil {
		return nil, err
	}
	c := s.hub.connectionFor(agent.DeviceID)
	if c == nil || !c.hasCapability(workspaceDraftCapability) {
		return fail("connect and update the execution worker before starting a Skill trial")
	}
	root := input.WorkspaceID
	if input.IssueID != "" {
		root = "issue:" + input.IssueID
	}
	settings, err := backing.WorkspaceDrafts(ctx, input.WorkspaceID, root)
	if err != nil {
		return nil, err
	}
	if len(choice.Drafts) > 0 && !settings.Enabled {
		return fail("workspace draft skills are disabled")
	}
	refs, err := sessionSkillRefs(ctx, s.store, input.WorkspaceID, agent.Provider)
	if err != nil {
		return nil, err
	}
	resolved := &store.ResolvedSkillSelection{Mode: choice.Mode, Drafts: []store.WorkspaceDraftSkill{}, LibraryRefs: []store.SessionSkillRef{}, ExcludedNames: []string{}}
	names := map[string]bool{}
	digests := map[string]bool{}
	for _, name := range choice.Names {
		name = strings.ToLower(strings.TrimPrefix(name, "draft:"))
		if name == "foundry" {
			return fail("Foundry governance cannot be excluded from a Skill trial")
		}
		names[name] = true
	}
	for _, reference := range choice.Drafts {
		draft, err := backing.WorkspaceDraftRevision(ctx, input.WorkspaceID, root, reference.ID, reference.Digest)
		if err != nil {
			return fail("draft snapshot not found in this execution root; refresh it before creating the trial")
		}
		if draft.Status != "ready" {
			return fail("draft snapshot is not ready")
		}
		if strings.EqualFold(draft.Name, "foundry") {
			return fail("Foundry governance cannot be replaced by a trial")
		}
		names[strings.ToLower(draft.Name)] = true
		digests[draft.Digest] = true
		if draft.SourceDigest != "" {
			digests[draft.SourceDigest] = true
		}
		if choice.Mode == "include" {
			resolved.Drafts = append(resolved.Drafts, draft)
		}
	}
	for _, reference := range choice.Library {
		found := -1
		for i, ref := range refs {
			if ref.SkillID == reference.SkillID {
				found = i
				break
			}
		}
		if found < 0 || reference.Revision < 1 {
			return fail("library trial revisions must belong to a selected workspace Skill")
		}
		if strings.EqualFold(refs[found].Name, "foundry") {
			return fail("Foundry governance revisions cannot be overridden")
		}
		pkg, err := s.store.GetSkillPackage(ctx, reference.SkillID, reference.Revision)
		if err != nil {
			return nil, err
		}
		refs[found].Revision = pkg.Revision
		refs[found].Checksum = pkg.Checksum
		refs[found].ByteSize = pkg.ByteSize
		index, err := s.store.GetSkillRevisionIndex(ctx, reference.SkillID, pkg.Revision)
		if err != nil {
			return nil, err
		}
		refs[found].SourceDigest = index.SourceDigest
	}
	excludedChecksums := map[string]bool{}
	for _, ref := range refs {
		if names[strings.ToLower(ref.Name)] {
			excludedChecksums[ref.Checksum] = true
		}
	}
	for _, ref := range refs {
		excluded := names[strings.ToLower(ref.Name)] || (ref.Name != "foundry" && excludedChecksums[ref.Checksum])
		if !excluded && len(digests) > 0 && ref.Name != "foundry" {
			var index store.SkillRevisionIndex
			var err error
			if builtin, ok := builtinskills.Lookup(ref.SkillID); ok {
				index, err = skillarchive.Inspect(builtin.Package)
			} else {
				index, err = s.store.GetSkillRevisionIndex(ctx, ref.SkillID, ref.Revision)
			}
			if err != nil {
				return nil, err
			}
			excluded = digests[index.SourceDigest]
		}
		if excluded {
			resolved.ExcludedNames = append(resolved.ExcludedNames, ref.Name)
		} else {
			resolved.LibraryRefs = append(resolved.LibraryRefs, ref)
		}
	}
	for name := range names {
		resolved.ExcludedNames = append(resolved.ExcludedNames, name)
	}
	workspace, err := s.store.GetWorkspace(ctx, input.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if agent.DeviceID != workspace.DeviceID && len(resolved.Drafts) > 0 {
		source := s.hub.connectionFor(workspace.DeviceID)
		if source == nil || !source.hasCapability(workspaceDraftCapability) {
			return fail("source device is unavailable for exact draft snapshot transfer")
		}
		for _, draft := range resolved.Drafts {
			raw, _ := json.Marshal(draft)
			transferContext, cancel := context.WithTimeout(ctx, 60*time.Second)
			transfer, err := daemonRequest[draftExportReply](transferContext, source, wsExportDraftSkillType, raw)
			cancel()
			if err != nil {
				return nil, err
			}
			if transfer.Error != "" {
				return fail(transfer.Error)
			}
			if transfer.ID != draft.ID || transfer.Digest != draft.Digest {
				return fail("source device returned a different draft snapshot")
			}
			resolved.Transfers = append(resolved.Transfers, transfer.DraftSkillTransfer)
		}
	}
	return resolved, nil
}

type draftExportReply struct {
	store.DraftSkillTransfer
	Error string `json:"error,omitempty"`
}

func (s *Server) prepareSessionSkillSelection(ctx context.Context, input *store.CreateAgentSessionInput) error {
	if input.ParentSessionID != "" && input.Source != "naming" && input.Source != store.DigestSessionSource {
		parent, parentErr := s.store.GetAgentSessionSummary(ctx, input.ParentSessionID)
		if parentErr != nil {
			return parentErr
		}
		if parent.SkillSelection != nil {
			if input.SkillSelection != nil || input.WorkspaceID != parent.WorkspaceID || input.IssueID != parent.IssueID {
				return &statusError{http.StatusBadRequest, errors.New("Skill trial children inherit the parent's locked inputs; create a different trial from the original creator session")}
			}
			if input.NativeSessionID != "" || input.ForkSessionID != "" || input.ChatID != "" || input.ImportedContext != "" || input.ProfileTransitionNote != "" {
				return &statusError{http.StatusBadRequest, errors.New("Skill trial children require clean native history")}
			}
			input.ResolvedSkillSelection = parent.SkillSelection
		}
	}
	if input.SkillSelection != nil {
		resolved, err := s.resolveSkillTrial(ctx, *input)
		if err != nil {
			return err
		}
		input.ResolvedSkillSelection = resolved
	}

	return nil
}
