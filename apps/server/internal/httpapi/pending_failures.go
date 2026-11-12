package httpapi

import (
	"context"
	"log"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

const pendingFailureSweepInterval = 10 * time.Minute

var (
	failureProviderMismatch = regexp.MustCompile(`(?i)(provider (?:does not match|mismatch)|uses .{1,120} but your current provider is|current provider is .{1,80}(?:not|instead)|profile .{1,100}(?:not assigned|no longer assigned))`)
	failureHostStopped      = regexp.MustCompile(`(?i)\b(?:execution host (?:has )?stopped|host stopped|worker stopped)\b`)
	failureProviderDown     = regexp.MustCompile(`(?i)(?:\b(?:502|503|504)\b|no eligible upstream account|no (?:upstream |usable |eligible )?account[^.\n]{0,80}(?:available|eligible)|service unavailable|bad gateway|gateway timeout|gateway[^.\n]{0,80}(?:unavailable|no available account)|overloaded)`)
	failureQuotaReset       = regexp.MustCompile(`(?i)\b(?:weekly|monthly|daily|rolling|usage|account|upstream)[ _-]*(?:quota )?limit\b`)
	failureISOReset         = regexp.MustCompile(`\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b`)
	failureDurationReset    = regexp.MustCompile(`(?i)\bin\s+(\d+)\s*h(?:\s*(\d+)\s*m)?`)
	failureMonthReset       = regexp.MustCompile(`(?i)\b(?:resets?|available again|try again)\s+(?:at\s+)?([A-Z][a-z]{2,8})\s+(\d{1,2})(?:,\s*(\d{4}))?(?:,)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?`)
	failureUTCTimeReset     = regexp.MustCompile(`(?i)\b(?:resets?|available again|try again|retry(?: after)?|until)\b[^\n.]{0,50}?\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*UTC\b`)
	mismatchExpected        = regexp.MustCompile(`(?i)\buses\s+([^,\s]+),?\s+but your current provider is\s+([^.\s]+)`)
)

type turnFailure struct {
	category  string
	provider  string
	accountID string
	resetAt   time.Time
}

// recordTurnFailure creates or merges the alert for a terminal failure. It is
// called only after the server knows it will not schedule another retry.
func (r pendingReactions) recordTurnFailure(ctx context.Context, session store.AgentSession, failure, code string) {
	if !r.s.pendingKept(ctx, session) {
		return
	}
	detail := strings.TrimSpace(failure)
	if detail == "" || strings.Contains(strings.ToLower(detail), "session was canceled") {
		return
	}
	classified := classifyTurnFailure(code, detail, time.Now().UTC())
	handler, assistantID := r.s.assistant.Handler(ctx, session)
	eventID := terminalFailureEventID(ctx, r.s, session, detail)
	item := store.PendingItem{
		EventID:          eventID,
		UserID:           session.CreatedByUserID,
		WorkspaceID:      session.WorkspaceID,
		SessionID:        session.ID,
		Source:           store.PendingSourceTurnFailed,
		Key:              pendingFailureKey(session, classified),
		Title:            pendingTitle(firstLine(detail)),
		Excerpt:          textcut.Excerpt(detail, pendingExcerptLimit),
		Handler:          handler,
		AssistantID:      assistantID,
		FailureCategory:  classified.category,
		FailureProvider:  classified.provider,
		FailureAccountID: classified.accountID,
		FailureResetAt:   formatPendingTime(classified.resetAt),
		FailureSessions:  []string{session.ID},
	}
	if classified.resetAt.IsZero() {
		item.FailureResetAt = ""
	}
	if _, _, err := r.s.store.RecordPendingItem(ctx, item); err != nil {
		log.Printf("record terminal failure pending item of %s: %v", session.ID, err)
	}
}

func terminalFailureEventID(ctx context.Context, server *Server, session store.AgentSession, failure string) string {
	events, _, err := server.store.AgentSessionEventWindow(ctx, session.ID, "", 50)
	if err == nil {
		for _, event := range events {
			if event.Label != store.ProcessLabelSessionFailed || event.Level != "error" {
				continue
			}
			if event.Metadata != nil && event.Metadata.WorkerFailure != nil {
				inputID := event.Metadata.WorkerFailure.InputID
				if inputID != "" && session.Input.ID != "" && inputID != session.Input.ID {
					continue
				}
			}
			if strings.TrimSpace(event.Detail) == failure {
				return event.ID
			}
		}
	}
	return "turn_failed:" + session.ID + ":" + session.Input.ID
}

func classifyTurnFailure(code, text string, at time.Time) turnFailure {
	lower := strings.ToLower(strings.TrimSpace(text))
	category := store.PendingFailureOther
	switch {
	case failureProviderMismatch.MatchString(text):
		category = store.PendingFailureProviderMismatch
	case failureHostStopped.MatchString(text):
		category = store.PendingFailureHostStopped
	case modelpool.QuotaExhausted(code, text) || failureQuotaReset.MatchString(text):
		category = store.PendingFailureQuotaExhausted
	case modelpool.RateLimited(code, text):
		category = store.PendingFailureRateLimited
	case failureProviderDown.MatchString(text):
		category = store.PendingFailureProviderUnavailable
	case strings.Contains(lower, "rate limit") || strings.Contains(lower, "too many requests"):
		category = store.PendingFailureRateLimited
	}
	return turnFailure{
		category: category,
		resetAt:  parseFailureReset(text, at),
	}
}

func pendingFailureKey(session store.AgentSession, failure turnFailure) string {
	accountID := failureAccountID(session)
	key := "turn_failed:" + url.QueryEscape(session.CreatedByUserID) + ":" +
		failure.category + ":" + url.QueryEscape(string(session.Provider)) + ":" + url.QueryEscape(accountID)
	if failure.category == store.PendingFailureOther {
		key += ":session:" + url.QueryEscape(session.ID)
	}
	return key
}

func failureAccountID(session store.AgentSession) string {
	switch {
	case session.ProfileID != "":
		return session.ProfileID
	case session.ProfileFingerprint != "":
		return "fingerprint:" + session.ProfileFingerprint
	case session.AgentID != "":
		return "agent:" + session.AgentID
	default:
		return "device:" + session.DeviceID
	}
}

func parseFailureReset(text string, after time.Time) time.Time {
	if match := failureISOReset.FindString(text); match != "" {
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if parsed, err := time.Parse(layout, match); err == nil {
				return parsed.UTC()
			}
		}
	}
	if match := failureDurationReset.FindStringSubmatch(text); match != nil {
		hours, _ := strconv.Atoi(match[1])
		minutes, _ := strconv.Atoi(match[2])
		return after.Add(time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute).UTC()
	}
	if match := failureMonthReset.FindStringSubmatch(text); match != nil {
		month, err := time.Parse("January", match[1])
		if err != nil {
			month, err = time.Parse("Jan", match[1])
		}
		day, _ := strconv.Atoi(match[2])
		year := after.Year()
		if match[3] != "" {
			year, _ = strconv.Atoi(match[3])
		}
		hour, _ := strconv.Atoi(match[4])
		minute, _ := strconv.Atoi(match[5])
		if strings.EqualFold(match[6], "pm") && hour < 12 {
			hour += 12
		}
		if strings.EqualFold(match[6], "am") && hour == 12 {
			hour = 0
		}
		location := time.UTC
		if zone := strings.TrimSpace(match[7]); zone != "" {
			if loaded, err := time.LoadLocation(zone); err == nil {
				location = loaded
			}
		}
		if err == nil {
			reset := time.Date(year, month.Month(), day, hour, minute, 0, 0, location)
			if match[3] == "" && reset.Before(after.Add(-24*time.Hour)) {
				reset = reset.AddDate(1, 0, 0)
			}
			return reset.UTC()
		}
	}
	if match := failureUTCTimeReset.FindStringSubmatch(text); match != nil {
		hour, _ := strconv.Atoi(match[1])
		minute, _ := strconv.Atoi(match[2])
		if strings.EqualFold(match[3], "pm") && hour < 12 {
			hour += 12
		}
		if strings.EqualFold(match[3], "am") && hour == 12 {
			hour = 0
		}
		reset := time.Date(after.Year(), after.Month(), after.Day(), hour, minute, 0, 0, time.UTC)
		if !reset.After(after.Add(-5 * time.Minute)) {
			reset = reset.Add(24 * time.Hour)
		}
		return reset.UTC()
	}
	return time.Time{}
}

func failureExpiry(item store.PendingItem, now time.Time) string {
	if reset := parseStoredPendingTime(item.FailureResetAt); !reset.IsZero() && !reset.After(now) {
		return "reset_elapsed"
	}
	if !parseStoredPendingTime(item.FailureResetAt).IsZero() {
		return ""
	}
	lastSeen := parseStoredPendingTime(item.UpdatedAt)
	if lastSeen.IsZero() {
		lastSeen = parseStoredPendingTime(item.CreatedAt)
	}
	switch item.FailureCategory {
	case store.PendingFailureRateLimited:
		if !lastSeen.IsZero() && !lastSeen.Add(time.Hour).After(now) {
			return "rate_limit_window_elapsed"
		}
	case store.PendingFailureProviderUnavailable:
		if !lastSeen.IsZero() && !lastSeen.Add(6*time.Hour).After(now) {
			return "provider_unavailable_window_elapsed"
		}
	}
	return ""
}

func parseStoredPendingTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed.UTC()
}

func (r pendingReactions) resolveTurnFailureSuccess(ctx context.Context, session store.AgentSession) {
	items, err := r.s.store.ListPendingItems(ctx, session.CreatedByUserID, []string{store.PendingOpen}, "", 500)
	if err != nil {
		log.Printf("pending failures: list after success of %s: %v", session.ID, err)
		return
	}
	for _, item := range items {
		if item.Source != store.PendingSourceTurnFailed {
			continue
		}
		matchesSession := item.SessionID == session.ID || slices.Contains(item.FailureSessions, session.ID)
		matchesAccount := item.FailureCategory != store.PendingFailureOther &&
			item.FailureProvider == string(session.Provider) && item.FailureAccountID == failureAccountID(session)
		if !matchesSession && !matchesAccount {
			continue
		}
		r.resolve(ctx, store.PendingResolution{
			Key: item.Key, Sources: []string{store.PendingSourceTurnFailed}, State: store.PendingDone,
			ResolutionReason: store.PendingResolutionAutoResolved, ResolutionDetail: "turn_succeeded",
		})
	}
}

// maintainPendingTurnFailures migrates the pre-DEV-197 items on its first
// pass, then closes failures that outcomes or configured windows made moot.
func (s *Server) maintainPendingTurnFailures(ctx context.Context) {
	items, err := s.store.ListOpenPendingItemsBySource(ctx, store.PendingSourceTurnFailed)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("pending failures: list open: %v", err)
		}
		return
	}
	now := time.Now().UTC()
	groups := map[string][]store.PendingItem{}
	for _, item := range items {
		session, sessionErr := s.store.GetAgentSessionSummary(ctx, item.SessionID)
		if item.FailureCategory == "" {
			failureAt := parseStoredPendingTime(item.UpdatedAt)
			if failureAt.IsZero() {
				failureAt = parseStoredPendingTime(item.CreatedAt)
			}
			if failureAt.IsZero() {
				failureAt = now
			}
			category := classifyTurnFailure("", item.Excerpt, failureAt)
			if sessionErr == nil {
				category.provider = string(session.Provider)
				category.accountID = failureAccountID(session)
			}
			migrated := item
			migrated.FailureCategory = category.category
			migrated.FailureProvider = category.provider
			migrated.FailureAccountID = category.accountID
			migrated.FailureResetAt = ""
			if !category.resetAt.IsZero() {
				migrated.FailureResetAt = formatPendingTime(category.resetAt)
			}
			migrated.FailureSessions = mergeStringList(migrated.FailureSessions, item.SessionID)
			if detail := failureExpiry(migrated, now); detail != "" {
				s.resolveTurnFailure(ctx, item, detail)
				continue
			}
			if migrated.FailureCategory == store.PendingFailureProviderMismatch && sessionErr == nil &&
				providerMismatchResolved(migrated, session) {
				s.resolveTurnFailure(ctx, item, "provider_changed")
				continue
			}
			if sessionOutcomeResolved(ctx, s.store, migrated, now) {
				s.resolveTurnFailure(ctx, item, "turn_succeeded")
				continue
			}
			key := pendingFailureKey(session, category)
			if sessionErr != nil {
				key = "turn_failed:" + url.QueryEscape(item.UserID) + ":" + category.category +
					":unknown:unknown:session:" + url.QueryEscape(item.SessionID)
			}
			migrated.Key = key
			groups[key] = append(groups[key], item)
			continue
		}
		if detail := failureExpiry(item, now); detail != "" {
			s.resolveTurnFailure(ctx, item, detail)
			continue
		}
		if item.FailureCategory == store.PendingFailureProviderMismatch && sessionErr == nil &&
			providerMismatchResolved(item, session) {
			s.resolveTurnFailure(ctx, item, "provider_changed")
			continue
		}
		if sessionOutcomeResolved(ctx, s.store, item, now) {
			s.resolveTurnFailure(ctx, item, "turn_succeeded")
		}
	}
	for key, sources := range groups {
		target := sources[len(sources)-1]
		session, sessionErr := s.store.GetAgentSessionSummary(ctx, target.SessionID)
		failureAt := parseStoredPendingTime(target.UpdatedAt)
		if failureAt.IsZero() {
			failureAt = now
		}
		category := classifyTurnFailure("", target.Excerpt, failureAt)
		if sessionErr == nil {
			category.provider = string(session.Provider)
			category.accountID = failureAccountID(session)
		}
		target.Key = key
		target.Source = store.PendingSourceTurnFailed
		target.State = store.PendingOpen
		target.FailureCategory = category.category
		target.FailureProvider = category.provider
		target.FailureAccountID = category.accountID
		target.FailureResetAt = ""
		if !category.resetAt.IsZero() {
			target.FailureResetAt = formatPendingTime(category.resetAt)
		}
		ids := make([]string, 0, len(sources))
		for _, source := range sources {
			ids = append(ids, source.ID)
		}
		if _, _, err := s.store.MergePendingItems(ctx, target, ids); err != nil {
			log.Printf("pending failures: merge %s: %v", key, err)
		}
	}
}

func (s *Server) resolveTurnFailure(ctx context.Context, item store.PendingItem, detail string) {
	_, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{
		Key: item.Key, Sources: []string{store.PendingSourceTurnFailed}, State: store.PendingDone,
		ResolutionReason: store.PendingResolutionAutoResolved, ResolutionDetail: detail,
	})
	if err != nil {
		log.Printf("pending failures: resolve %s: %v", item.ID, err)
	}
}

func providerMismatchResolved(item store.PendingItem, session store.AgentSession) bool {
	if item.FailureProvider != string(session.Provider) || item.FailureAccountID != failureAccountID(session) {
		return true
	}
	match := mismatchExpected.FindStringSubmatch(item.Excerpt)
	if match == nil {
		return false
	}
	expected, current := match[1], match[2]
	currentValues := []string{string(session.Provider), session.ProfileID, failureAccountID(session), session.AgentID}
	return slices.ContainsFunc(currentValues, func(value string) bool {
		return value != "" && providerNameEqual(value, expected) && !providerNameEqual(current, expected)
	})
}

func providerNameEqual(left, right string) bool {
	// Older Codex errors named the built-in gateway with a display prefix
	// that the stored profile id does not carry.
	left = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(left)), "foundry_")
	right = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(right)), "foundry_")
	return left != "" && left == right
}

func sessionOutcomeResolved(ctx context.Context, server Backend, item store.PendingItem, now time.Time) bool {
	sessionIDs := item.FailureSessions
	if len(sessionIDs) == 0 && item.SessionID != "" {
		sessionIDs = []string{item.SessionID}
	}
	created := parseStoredPendingTime(item.CreatedAt)
	for _, id := range sessionIDs {
		session, err := server.GetAgentSessionSummary(ctx, id)
		if err != nil {
			continue
		}
		completed := parseStoredPendingTime(session.CompletedAt)
		if session.Status == "completed" && !completed.IsZero() && completed.After(created) && !completed.After(now) {
			return true
		}
	}
	return false
}

func mergeStringList(current []string, values ...string) []string {
	result := append([]string(nil), current...)
	for _, value := range values {
		if value == "" || slices.Contains(result, value) {
			continue
		}
		result = append(result, value)
	}
	return result
}

func (r pendingReactions) closePreviousTurnFailures(ctx context.Context, session store.AgentSession) {
	// Kept as a named boundary for SessionChanged: success is the only
	// SessionChanged outcome that resolves grouped failures by root key.
	r.resolveTurnFailureSuccess(ctx, session)
}
