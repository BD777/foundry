// Package modelpool chooses equivalent model ids and plans rate-limit retries.
// It has no storage, transport or inference dependencies; callers provide the
// recent usage and persist the returned decisions.
package modelpool

import (
	"math"
	"regexp"
	"strings"
	"time"
)

const (
	BaseRetryDelay = 2 * time.Second
	MaxRetryDelay  = 30 * time.Second
)

// Member is one model id in an equivalent-model group.
type Member struct {
	Model           string
	TokensPerMinute int64
	Weight          int
}

// Pool is the pure form of an equivalent-model group.
type Pool struct {
	Members []Member
}

// Decision names the member to use and the cursor after this choice.
type Decision struct {
	Index  int
	Model  string
	Cursor int
}

// Choose picks the member with the largest remaining token budget. When no
// member declares a budget, it uses weighted round-robin. Cursor is the next
// weighted slot to consider, supplied by the caller's durable allocation row.
func Choose(pool Pool, used map[string]int64, cursor int) (Decision, bool) {
	return choose(pool, used, cursor, "")
}

// Next chooses another member when possible. It is used after a rate limit so
// the retry does not immediately hit the same id.
func Next(pool Pool, current string, used map[string]int64, cursor int) (Decision, bool) {
	return choose(pool, used, cursor, strings.TrimSpace(current))
}

func choose(pool Pool, used map[string]int64, cursor int, exclude string) (Decision, bool) {
	if len(pool.Members) == 0 {
		return Decision{}, false
	}
	quota := make([]int, 0, len(pool.Members))
	for index, member := range pool.Members {
		if strings.TrimSpace(member.Model) == "" || member.Model == exclude {
			continue
		}
		if member.TokensPerMinute > 0 {
			quota = append(quota, index)
		}
	}
	if len(quota) > 0 {
		best := quota[0]
		bestRemaining := remaining(pool.Members[best], used)
		for _, index := range quota[1:] {
			candidate := remaining(pool.Members[index], used)
			if candidate > bestRemaining {
				best, bestRemaining = index, candidate
			}
		}
		return Decision{Index: best, Model: pool.Members[best].Model}, true
	}
	index, nextCursor := weightedIndex(pool.Members, cursor, exclude)
	if index < 0 && exclude != "" {
		// A one-member pool still has to retry that member.
		index, nextCursor = weightedIndex(pool.Members, cursor, "")
	}
	if index < 0 {
		return Decision{}, false
	}
	return Decision{Index: index, Model: pool.Members[index].Model, Cursor: nextCursor}, true
}

func remaining(member Member, used map[string]int64) int64 {
	if member.TokensPerMinute <= 0 {
		return math.MinInt64
	}
	spent := used[member.Model]
	if spent < 0 {
		spent = 0
	}
	return member.TokensPerMinute - spent
}

func weightedIndex(members []Member, cursor int, exclude string) (int, int) {
	total := 0
	for _, member := range members {
		if strings.TrimSpace(member.Model) != "" && member.Model != exclude {
			total += memberWeight(member)
		}
	}
	if total == 0 {
		return -1, 0
	}
	slot := cursor % total
	if slot < 0 {
		slot += total
	}
	for index, member := range members {
		if strings.TrimSpace(member.Model) == "" || member.Model == exclude {
			continue
		}
		weight := memberWeight(member)
		if slot < weight {
			return index, (slot + 1) % total
		}
		slot -= weight
	}
	return -1, 0
}

func memberWeight(member Member) int {
	if member.Weight > 0 {
		return member.Weight
	}
	return 1
}

// Backoff returns exponential delay with a caller-supplied jitter. Jitter is
// clamped to one quarter of the exponential step so a retry cannot be delayed
// far beyond its normal interval.
func Backoff(attempt int, jitter time.Duration) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := BaseRetryDelay
	for step := 1; step < attempt && delay < MaxRetryDelay; step++ {
		delay *= 2
	}
	if delay > MaxRetryDelay {
		delay = MaxRetryDelay
	}
	limit := delay / 4
	jitter = max(jitter, 0)
	if jitter > limit {
		jitter = limit
	}
	return delay + jitter
}

var rateLimitPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bexceeded retry limit\b`),
	regexp.MustCompile(`(?i)\brate_limit_(?:exceeded|error)\b`),
	regexp.MustCompile(`(?i)\buser tpm rate limit exceeded\b`),
	regexp.MustCompile(`(?i)\bthrottle by model gateway\b`),
}

var genericRateLimitPattern = regexp.MustCompile(`(?i)\b(?:rate[ _-]?limit|too many requests)\b`)

var quotaExhaustedPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bupstream account quota\b`),
	regexp.MustCompile(`(?i)\b(?:insufficient|exceeded|exhausted)[ _-]*(?:quota|credits?)\b`),
	regexp.MustCompile(`(?i)\b(?:quota|credits?)[ _-]?(?:usage )?limit\b`),
	regexp.MustCompile(`(?i)\b(?:usage limit|quota exhausted|quota exceeded|credit balance|out of credits?)\b`),
	regexp.MustCompile(`(?i)\bbilling(?:[ _-](?:error|limit|hard limit))?\b`),
}

var generic429Pattern = regexp.MustCompile(`(?i)\b(?:status|http|error|code|api error)\D{0,12}429\b`)
var model429Context = regexp.MustCompile(`(?i)\b(?:model|provider|gateway|tokenhub|anthropic|openai|claude|codex|quota|token)\b`)
var quotaContext = regexp.MustCompile(`(?i)\b(?:quota|credit|billing)\b`)

// QuotaExhausted separates an account whose allowance is gone from ordinary
// throttling. A provider's structured quota code wins; explicit quota text
// overrides older model_rate_limit diagnoses because retrying cannot help.
func QuotaExhausted(code, text string) bool {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "model_quota_exhausted", "insufficient_quota", "billing_error",
		"billing_hard_limit_reached", "credit_balance_too_low",
		"quota_exhausted", "quota_exceeded":
		return true
	}
	text = strings.TrimSpace(text)
	for _, pattern := range quotaExhaustedPatterns {
		if pattern.MatchString(text) {
			return true
		}
	}
	return generic429Pattern.MatchString(text) && quotaContext.MatchString(text)
}

// RateLimited reports whether a terminal failure means the model service
// throttled this call. Exhausted account quota always wins over a stale
// rate-limit diagnosis. Otherwise free text is accepted only for known
// throttle phrases or a 429 with model-service context, so an unrelated HTTP
// 429 is not retried as a model request.
func RateLimited(code, text string) bool {
	if QuotaExhausted(code, text) {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(code), "model_rate_limit") {
		return true
	}
	text = strings.TrimSpace(text)
	for _, pattern := range rateLimitPatterns {
		if pattern.MatchString(text) {
			return true
		}
	}
	if !generic429Pattern.MatchString(text) {
		return false
	}
	return genericRateLimitPattern.MatchString(text) || model429Context.MatchString(text)
}
