package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	ErrModelGuideNotFound         = errors.New("model guide not found")
	ErrModelGuideRevisionNotFound = errors.New("model guide revision not found")
	ErrModelGuideInvalid          = errors.New("invalid model guide")
	ErrModelGuideAliasTaken       = errors.New("model guide alias is already used by another guide")
)

const (
	MaxModelObservationBody = 12000
	// MaxModelGuideSection bounds one section's bytes; MaxModelGuideBullets
	// bounds its bullet points, so a section stays a short list.
	MaxModelGuideSection = 4000
	MaxModelGuideBullets = 8
	MaxModelGuideAliases = 40
	MaxModelGuideField   = 200
)

func invalidModelGuide(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrModelGuideInvalid}, args...)...)
}

var modelGuideIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

var modelGuideBulletPattern = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s`)

var modelSlugRun = regexp.MustCompile(`[^a-z0-9.]+`)

// ValidModelGuideID reports whether id is a canonical guide id: a lower-case
// slug of at most 64 characters.
func ValidModelGuideID(id string) bool { return modelGuideIDPattern.MatchString(id) }

// SuggestedModelGuideID turns a provider's model id into a canonical id
// candidate: lower case, the vendor prefix before the last "/" dropped, runs
// of other characters folded to "-".
func SuggestedModelGuideID(model string) string {
	slug := strings.ToLower(strings.TrimSpace(model))
	if cut := strings.LastIndex(slug, "/"); cut >= 0 {
		slug = slug[cut+1:]
	}
	slug = strings.Trim(modelSlugRun.ReplaceAllString(slug, "-"), "-.")
	if len(slug) > 64 {
		slug = strings.Trim(slug[:64], "-.")
	}
	return slug
}

// NormalizeModelGuideAlias trims an alias and checks its fields.
func NormalizeModelGuideAlias(alias ModelGuideAlias) (ModelGuideAlias, error) {
	alias.ProviderKind = strings.TrimSpace(alias.ProviderKind)
	alias.ProviderID = strings.TrimSpace(alias.ProviderID)
	alias.Runtime = NativeRuntimeID(strings.TrimSpace(string(alias.Runtime)))
	alias.Model = strings.TrimSpace(alias.Model)
	switch {
	case alias.Model == "":
		return alias, invalidModelGuide("alias model is required")
	case len(alias.Model) > MaxModelGuideField || len(alias.ProviderID) > MaxModelGuideField:
		return alias, invalidModelGuide("alias model or providerId is too long")
	case alias.ProviderKind != "" && alias.ProviderKind != "subscription" && alias.ProviderKind != "api" &&
		alias.ProviderKind != "environment" && alias.ProviderKind != "discovered":
		return alias, invalidModelGuide("alias providerKind must be subscription, api, environment or discovered")
	case alias.Runtime != "" && alias.Runtime != "claude" && alias.Runtime != "codex":
		return alias, invalidModelGuide("alias runtime must be claude or codex")
	}
	return alias, nil
}

// ModelGuideAliasKey identifies an alias for equality, ignoring the case of
// the model id.
func ModelGuideAliasKey(alias ModelGuideAlias) string {
	return strings.Join([]string{alias.ProviderKind, alias.ProviderID, string(alias.Runtime), strings.ToLower(alias.Model)}, "\x00")
}

// ModelGuideSectionValues lists the sections by name, in display order.
func ModelGuideSectionValues(sections *ModelGuideSections) []struct {
	Name  string
	Value *string
} {
	return []struct {
		Name  string
		Value *string
	}{
		{"summary", &sections.Summary}, {"strengths", &sections.Strengths}, {"weaknesses", &sections.Weaknesses},
		{"briefing", &sections.Briefing}, {"avoid", &sections.Avoid}, {"pitfalls", &sections.Pitfalls},
		{"settings", &sections.Settings},
	}
}

// ValidateModelGuide checks what a saved guide must satisfy.
func ValidateModelGuide(guide ModelGuide) error {
	switch {
	case !ValidModelGuideID(guide.ID):
		return invalidModelGuide("guide id %q must be a lower-case slug (a-z, 0-9, '.', '_', '-'; at most 64 characters, starting with a letter or digit)", guide.ID)
	case strings.TrimSpace(guide.DisplayName) == "":
		return invalidModelGuide("guide displayName is required")
	case len(guide.DisplayName) > MaxModelGuideField || len(guide.Owner) > MaxModelGuideField || len(guide.Family) > MaxModelGuideField:
		return invalidModelGuide("guide displayName, owner or family is too long")
	case len(guide.Aliases) > MaxModelGuideAliases:
		return invalidModelGuide("a guide holds at most %d aliases", MaxModelGuideAliases)
	}
	sections := guide.Sections
	for _, section := range ModelGuideSectionValues(&sections) {
		if len(*section.Value) > MaxModelGuideSection {
			return invalidModelGuide("section %s is too long (maximum %d bytes)", section.Name, MaxModelGuideSection)
		}
		bullets := 0
		for _, line := range strings.Split(*section.Value, "\n") {
			if modelGuideBulletPattern.MatchString(line) {
				bullets++
			}
		}
		if bullets > MaxModelGuideBullets {
			return invalidModelGuide("section %s has %d bullet points (maximum %d); keep only what changes how work is handed over", section.Name, bullets, MaxModelGuideBullets)
		}
	}
	return nil
}

// ModelGuideEdit is one change to a guide. Apply receives the current guide
// (zero-valued with Revision 0 when the id is new) and edits it in place; the
// store stamps the revision, time and updater, and saves a snapshot only when
// Apply changed something.
type ModelGuideEdit struct {
	ChangeSummary string
	UpdatedBy     ModelGuideUpdater
	Apply         func(guide *ModelGuide) error
}

// ModelObservationFilter pages one guide's observations, newest first.
type ModelObservationFilter struct {
	OwnerUserID string
	GuideID     string
	Offset      int
	Limit       int
}

// ModelUsageTarget picks usage rows: a model id, narrowed to a provider
// (profile) and runtime when those are set.
type ModelUsageTarget struct {
	ProfileID string
	Runtime   string
	Model     string
}

// ModelUsage is worker usage of some models since a time, read from the usage
// statistics (usage_requests). Timing sums cover only requests that have it.
type ModelUsage struct {
	WorkerSessions int64
	Requests       int64
	// TimedRequests and RequestMs: requests with a measured duration.
	TimedRequests int64
	RequestMs     int64
	// ThroughputTokens and GenerationMs: requests with observed generation timing.
	ThroughputTokens int64
	GenerationMs     int64
}

type ModelGuideStore interface {
	// ModelUsage sums the owner's requests since a time for the targets.
	ModelUsage(ctx context.Context, since time.Time, ownerUserID string, targets []ModelUsageTarget) (ModelUsage, error)
	ListModelGuides(ctx context.Context, ownerUserID string) ([]ModelGuide, error)
	GetModelGuide(ctx context.Context, ownerUserID, id string) (ModelGuide, error)
	// EditModelGuide applies one edit in a transaction and reports whether it
	// saved a new revision.
	EditModelGuide(ctx context.Context, ownerUserID, id string, edit ModelGuideEdit) (ModelGuide, bool, error)
	ListModelGuideRevisions(ctx context.Context, ownerUserID, id string) ([]ModelGuideRevisionSummary, error)
	GetModelGuideRevision(ctx context.Context, ownerUserID, id string, revision int) (ModelGuideRevision, error)
	// ResolveModelGuide finds the guide with the most specific alias matching
	// target; empty fields of target match any alias.
	ResolveModelGuide(ctx context.Context, ownerUserID string, target ModelGuideAlias) (ModelGuide, ModelGuideAlias, bool, error)
	AppendModelObservation(ctx context.Context, ownerUserID string, observation ModelObservation) (ModelObservation, error)
	ListModelObservations(ctx context.Context, filter ModelObservationFilter) ([]ModelObservation, int, error)
}
