package modelpool

import (
	"testing"
	"time"
)

func TestChooseUsesLargestRemainingQuota(t *testing.T) {
	pool := Pool{Members: []Member{
		{Model: "small", TokensPerMinute: 100},
		{Model: "large", TokensPerMinute: 1_000},
	}}
	got, ok := Choose(pool, map[string]int64{"small": 50, "large": 600}, 0)
	if !ok || got.Model != "large" {
		t.Fatalf("Choose = %+v, %v; want large", got, ok)
	}
}

func TestChooseUsesWeightedRoundRobinWithoutQuota(t *testing.T) {
	pool := Pool{Members: []Member{
		{Model: "one", Weight: 1},
		{Model: "three", Weight: 3},
	}}
	var got []string
	cursor := 0
	for range 4 {
		decision, ok := Choose(pool, nil, cursor)
		if !ok {
			t.Fatal("Choose reported no member")
		}
		got = append(got, decision.Model)
		cursor = decision.Cursor
	}
	want := []string{"one", "three", "three", "three"}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("weighted order = %v, want %v", got, want)
		}
	}
}

func TestNextAvoidsTheFailedModel(t *testing.T) {
	pool := Pool{Members: []Member{{Model: "a"}, {Model: "b"}}}
	got, ok := Next(pool, "a", nil, 0)
	if !ok || got.Model != "b" {
		t.Fatalf("Next = %+v, %v; want b", got, ok)
	}
	single := Pool{Members: []Member{{Model: "a"}}}
	if got, ok = Next(single, "a", nil, 0); !ok || got.Model != "a" {
		t.Fatalf("single-member Next = %+v, %v; want same member", got, ok)
	}
}

func TestBackoffIsExponentialCappedAndJittered(t *testing.T) {
	cases := []struct {
		attempt int
		jitter  time.Duration
		want    time.Duration
	}{
		{1, 0, 2 * time.Second},
		{2, 300 * time.Millisecond, 4*time.Second + 300*time.Millisecond},
		{4, time.Second, 17 * time.Second},
		{10, 0, 30 * time.Second},
	}
	for _, test := range cases {
		if got := Backoff(test.attempt, test.jitter); got != test.want {
			t.Errorf("Backoff(%d, %s) = %s, want %s", test.attempt, test.jitter, got, test.want)
		}
	}
}

func TestRateLimitedPrefersStructuredCodeAndRejectsUnrelated429(t *testing.T) {
	for _, test := range []struct {
		code, text string
		want       bool
	}{
		{"model_rate_limit", "anything", true},
		{"", "API Error: 429 rate_limit_error", true},
		{"", "exceeded retry limit", true},
		{"", "user tpm rate limit exceeded", true},
		{"", "API Error: 429 Too Many Requests", true},
		{"model_quota_exhausted", "anything", false},
		{"model_rate_limit", "upstream account quota usage limit has been reached", false},
		{"", "openai: insufficient_quota", false},
		{"", "Your credit balance is too low", false},
		{"", "HTTP 429 from an unrelated service", false},
		{"", "GitHub API rate limit exceeded for 10.0.0.1", false},
		{"unknown", "model claude-opus-4-1 not found (request 4291)", false},
	} {
		if got := RateLimited(test.code, test.text); got != test.want {
			t.Errorf("RateLimited(%q, %q) = %v, want %v", test.code, test.text, got, test.want)
		}
	}
}

func TestQuotaExhaustedUsesStructuredCodeAndQuotaText(t *testing.T) {
	for _, test := range []struct {
		code, text string
		want       bool
	}{
		{"billing_error", "Request rejected", true},
		{"insufficient_quota", "", true},
		{"model_rate_limit", "upstream account quota usage limit has been reached", true},
		{"model_rate_limit", "API Error: 429 rate_limit_error", false},
		{"", "HTTP 429 from an unrelated service", false},
	} {
		if got := QuotaExhausted(test.code, test.text); got != test.want {
			t.Errorf("QuotaExhausted(%q, %q) = %v, want %v", test.code, test.text, got, test.want)
		}
	}
}
