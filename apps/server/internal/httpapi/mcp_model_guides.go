package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// modelGuideMCPTools is the tool Issue, clarification and verifier sessions
// never see; only the person's own chats and assistant read and write guides.
var modelGuideMCPTools = map[string]bool{"model_guides": true}

func modelGuideInvalid(message string, args ...any) error {
	return &statusError{http.StatusBadRequest, fmt.Errorf(message, args...)}
}

func mcpModelGuideAlias(call mcpCall) store.ModelGuideAlias {
	return store.ModelGuideAlias{
		ProviderKind: mcpArgString(call.args, "providerKind"), ProviderID: mcpArgString(call.args, "providerId"),
		Runtime: store.NativeRuntimeID(mcpArgString(call.args, "runtime")), Model: mcpArgString(call.args, "model"),
	}
}

type modelGuideSave struct {
	Guide store.ModelGuide `json:"guide"`
	// Saved is false when the request changed nothing, so no revision was made.
	Saved bool `json:"saved"`
}

func (s *Server) modelGuidesForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	owner, err := modelGuideOwner(s, ctx, call.actor)
	if err != nil {
		return "", err
	}
	id := mcpArgString(call.args, "id")
	needID := func() error {
		if id == "" {
			return modelGuideInvalid("id is required: the guide's canonical id; resolve finds it from a provider's model id")
		}
		return nil
	}
	switch action := mcpArgString(call.args, "action"); action {
	case "list":
		list, err := s.listModelGuides(ctx, owner)
		if err != nil {
			return "", err
		}
		return encodeJSON(list)
	case "resolve":
		resolution, err := s.resolveModelGuide(ctx, owner, mcpModelGuideAlias(call))
		if err != nil {
			return "", err
		}
		return encodeJSON(resolution)
	case "get":
		if err := needID(); err != nil {
			return "", err
		}
		if _, ok := call.args["revision"]; ok {
			revision, err := s.store.GetModelGuideRevision(ctx, owner, id, mcpArgNumber(call.args, "revision", 0))
			if err != nil {
				return "", modelGuideNotFound(err)
			}
			return encodeJSON(revision)
		}
		if _, ok := call.args["offset"]; ok {
			return s.modelObservationsForMCP(call, owner, id)
		}
		detail, err := s.modelGuideDetail(ctx, owner, id)
		if err != nil {
			return "", err
		}
		return encodeJSON(detail)
	case "observations":
		if err := needID(); err != nil {
			return "", err
		}
		return s.modelObservationsForMCP(call, owner, id)
	case "upsert":
		return s.upsertModelGuideForMCP(call, owner)
	case "add_alias", "remove_alias":
		if err := needID(); err != nil {
			return "", err
		}
		return s.editModelGuideAliasForMCP(call, owner, id, action == "add_alias")
	case "observe":
		if err := needID(); err != nil {
			return "", err
		}
		observation := store.ModelObservation{
			GuideID: id, Body: mcpArgString(call.args, "body"), SessionIDs: mcpArgList(call.args, "sessionIds"),
		}
		if call.actor.Agent() {
			observation.AuthorSessionID = call.actor.Identity.SessionID
		}
		saved, err := s.store.AppendModelObservation(ctx, owner, observation)
		if err != nil {
			return "", modelGuideWriteError(modelGuideNotFound(err))
		}
		return encodeJSON(saved)
	default:
		return "", modelGuideInvalid("action must be list, get, observations, resolve, upsert, add_alias, remove_alias or observe")
	}
}

func (s *Server) modelObservationsForMCP(call mcpCall, owner, id string) (string, error) {
	if _, err := s.store.GetModelGuide(call.r.Context(), owner, id); err != nil {
		return "", modelGuideNotFound(err)
	}
	offset := max(mcpArgNumber(call.args, "offset", 0), 0)
	limit := min(max(mcpArgNumber(call.args, "limit", defaultModelObservations), 1), maxModelObservations)
	page, err := s.modelObservationPage(call.r.Context(), owner, id, offset, limit)
	if err != nil {
		return "", err
	}
	return encodeJSON(page)
}

// applyModelGuideSections sets the sections the call names and keeps the rest.
func applyModelGuideSections(sections *store.ModelGuideSections, given map[string]*string) error {
	for name, value := range given {
		if value == nil {
			continue
		}
		found := false
		for _, section := range store.ModelGuideSectionValues(sections) {
			if section.Name == name {
				*section.Value, found = strings.TrimSpace(*value), true
			}
		}
		if !found {
			return modelGuideInvalid("unknown section %q: use summary, strengths, weaknesses, briefing, avoid, pitfalls or settings", name)
		}
	}
	return nil
}

func (s *Server) upsertModelGuideForMCP(call mcpCall, owner string) (string, error) {
	ctx := call.r.Context()
	id := mcpArgString(call.args, "id")
	summary := mcpArgString(call.args, "changeSummary")
	if id == "" || summary == "" {
		return "", modelGuideInvalid("upsert needs id and changeSummary (why the guide changes: which sessions, what happened)")
	}
	var sections map[string]*string
	if raw, ok := call.args["sections"]; ok {
		if err := json.Unmarshal(raw, &sections); err != nil {
			return "", modelGuideInvalid("sections must be an object of section name to Markdown text")
		}
	}
	var aliases []store.ModelGuideAlias
	replaceAliases := false
	if raw, ok := call.args["aliases"]; ok {
		if err := json.Unmarshal(raw, &aliases); err != nil {
			return "", modelGuideInvalid("aliases must be a list of {providerKind?, providerId?, runtime?, model}")
		}
		replaceAliases = true
	}
	_, hasOwner := call.args["owner"]
	_, hasFamily := call.args["family"]
	updater, err := s.modelGuideUpdater(ctx, call.actor, owner)
	if err != nil {
		return "", err
	}
	guide, saved, err := s.store.EditModelGuide(ctx, owner, id, store.ModelGuideEdit{
		ChangeSummary: summary, UpdatedBy: updater,
		Apply: func(guide *store.ModelGuide) error {
			if displayName := mcpArgString(call.args, "displayName"); displayName != "" {
				guide.DisplayName = displayName
			} else if guide.DisplayName == "" {
				guide.DisplayName = id
			}
			if hasOwner {
				guide.Owner = mcpArgString(call.args, "owner")
			}
			if hasFamily {
				guide.Family = mcpArgString(call.args, "family")
			}
			if replaceAliases {
				guide.Aliases = aliases
			}
			return applyModelGuideSections(&guide.Sections, sections)
		},
	})
	if err != nil {
		return "", modelGuideWriteError(err)
	}
	return encodeJSON(modelGuideSave{Guide: guide, Saved: saved})
}

func (s *Server) editModelGuideAliasForMCP(call mcpCall, owner, id string, add bool) (string, error) {
	ctx := call.r.Context()
	alias, err := normalizeModelGuideTarget(mcpModelGuideAlias(call))
	if err != nil {
		return "", err
	}
	summary := mcpArgString(call.args, "changeSummary")
	if summary == "" {
		verb := "Add"
		if !add {
			verb = "Remove"
		}
		summary = verb + " alias " + alias.Model
	}
	updater, err := s.modelGuideUpdater(ctx, call.actor, owner)
	if err != nil {
		return "", err
	}
	removed := false
	guide, saved, err := s.store.EditModelGuide(ctx, owner, id, store.ModelGuideEdit{
		ChangeSummary: summary, UpdatedBy: updater,
		Apply: func(guide *store.ModelGuide) error {
			if guide.Revision == 0 {
				return store.ErrModelGuideNotFound
			}
			key := store.ModelGuideAliasKey(alias)
			kept := make([]store.ModelGuideAlias, 0, len(guide.Aliases)+1)
			for _, existing := range guide.Aliases {
				if store.ModelGuideAliasKey(existing) == key {
					removed = true
					continue
				}
				kept = append(kept, existing)
			}
			if add {
				kept = append(kept, alias)
			}
			guide.Aliases = kept
			return nil
		},
	})
	if err != nil {
		return "", modelGuideWriteError(modelGuideNotFound(err))
	}
	if !add && !removed {
		return "", &statusError{http.StatusNotFound, errors.New("the guide has no such alias; get shows its aliases")}
	}
	return encodeJSON(modelGuideSave{Guide: guide, Saved: saved})
}

func modelGuideWriteError(err error) error {
	var status *statusError
	if errors.As(err, &status) || store.IsBusy(err) {
		return err
	}
	if errors.Is(err, store.ErrModelGuideAliasTaken) {
		return &statusError{http.StatusConflict, err}
	}
	if errors.Is(err, store.ErrModelGuideInvalid) {
		return &statusError{http.StatusBadRequest, err}
	}
	return err
}
