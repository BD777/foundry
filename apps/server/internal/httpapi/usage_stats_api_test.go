package httpapi

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestUsageStatsAPIEnforcesOwnershipAndAggregates(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	member := inviteAndJoin(t, handler, owner, store.RoleMember, "usage-member")
	ctx := context.Background()
	users, err := server.store.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	userID := map[string]string{}
	for _, user := range users {
		userID[user.Username] = user.ID
	}
	stats := server.store.(store.UsageStatsStore)
	now := time.Now().UTC()
	recordUsageForAPITest(t, stats, "owner", userID["owner"], now.Add(-2*time.Hour), "model-owner", 300, 200, 0.5)
	recordUsageForAPITest(t, stats, "member", userID["usage-member"], now.Add(-time.Hour), "model-member", 100, 50, 0)

	all := usageStatsAPIForTest(t, handler, owner, "/api/usage-stats?granularity=day&groupBy=user&from="+
		url.QueryEscape(now.Add(-24*time.Hour).Format(time.RFC3339Nano))+
		"&to="+url.QueryEscape(now.Add(time.Hour).Format(time.RFC3339Nano)), http.StatusOK)
	if all.Total != 2 || len(all.Items) != 2 {
		t.Fatalf("admin result = total %d items %d", all.Total, len(all.Items))
	}
	page := usageStatsAPIForTest(t, handler, owner, "/api/usage-stats?granularity=day&groupBy=user&limit=1&offset=1&from="+
		url.QueryEscape(now.Add(-24*time.Hour).Format(time.RFC3339Nano))+
		"&to="+url.QueryEscape(now.Add(time.Hour).Format(time.RFC3339Nano)), http.StatusOK)
	if page.Total != 2 || page.Limit != 1 || page.Offset != 1 || len(page.Items) != 1 {
		t.Fatalf("usage stats page = %+v", page)
	}
	ownerOnly := usageStatsAPIForTest(t, handler, owner, "/api/usage-stats?granularity=day&groupBy=user&userId="+
		url.QueryEscape(userID["owner"])+"&from="+url.QueryEscape(now.Add(-24*time.Hour).Format(time.RFC3339Nano))+
		"&to="+url.QueryEscape(now.Add(time.Hour).Format(time.RFC3339Nano)), http.StatusOK)
	if ownerOnly.Total != 1 || ownerOnly.Items[0].UserID != userID["owner"] {
		t.Fatalf("admin user filter = %+v", ownerOnly)
	}
	ownerPoint := ownerOnly.Items[0]
	if ownerPoint.Turns != 1 || ownerPoint.Requests != 2 || ownerPoint.InputTokens != 300 ||
		ownerPoint.CacheReadTokens != 200 || ownerPoint.OutputTokens != 30 ||
		math.Abs(ownerPoint.CostUSD-0.5) > 0.0001 ||
		ownerPoint.AverageTokensPerSecond == nil || math.Abs(*ownerPoint.AverageTokensPerSecond-10) > 0.001 ||
		ownerPoint.MedianTokensPerSecond == nil || *ownerPoint.MedianTokensPerSecond != 10 ||
		ownerPoint.TtftP50Ms == nil || *ownerPoint.TtftP50Ms != 100 ||
		ownerPoint.TtftP90Ms == nil || *ownerPoint.TtftP90Ms != 300 {
		t.Fatalf("owner aggregate = %+v", ownerPoint)
	}
	if len(ownerPoint.CostSources) != 1 || ownerPoint.CostSources[0].Source != store.UsageCostReported ||
		ownerPoint.CostSources[0].Turns != 1 {
		t.Fatalf("cost source distribution = %+v", ownerPoint.CostSources)
	}

	mine := usageStatsAPIForTest(t, handler, member, "/api/usage-stats?granularity=day&groupBy=user&from="+
		url.QueryEscape(now.Add(-24*time.Hour).Format(time.RFC3339Nano))+
		"&to="+url.QueryEscape(now.Add(time.Hour).Format(time.RFC3339Nano)), http.StatusOK)
	if mine.Total != 1 || mine.Items[0].UserID != userID["usage-member"] {
		t.Fatalf("member saw another person's usage: %+v", mine)
	}
	usageStatsAPIForTest(t, handler, member, "/api/usage-stats?userId="+
		url.QueryEscape(userID["owner"]), http.StatusForbidden)
	usageStatsAPIForTest(t, handler, owner, "/api/usage-stats?granularity=hour&from="+
		url.QueryEscape(now.Add(-100*24*time.Hour).Format(time.RFC3339Nano)), http.StatusBadRequest)
}

func recordUsageForAPITest(t *testing.T, stats store.UsageStatsStore, name, userID string, at time.Time, model string, input, cacheRead int64, cost float64) {
	t.Helper()
	started := at.Format(time.RFC3339Nano)
	turn := store.UsageTurn{
		UsageReported:   true,
		SessionID:       "sess_" + name,
		InputID:         "input_" + name,
		UserID:          userID,
		WorkspaceID:     "ws_" + name,
		DeviceID:        "dev_" + name,
		Entry:           store.UsageEntryChat,
		Runtime:         "claude",
		ProviderLabel:   "provider-" + name,
		RequestedModel:  model,
		Model:           model,
		StartedAt:       started,
		EndedAt:         at.Add(time.Second).Format(time.RFC3339Nano),
		DurationMs:      1_000,
		InputTokens:     input,
		CacheReadTokens: cacheRead,
		OutputTokens:    30,
		ModelRequests:   2,
		CostUSD:         cost,
		CostSource:      store.UsageCostUnknown,
		Outcome:         store.UsageOutcomeCompleted,
	}
	if cost > 0 {
		turn.CostSource = store.UsageCostReported
	}
	requests := []store.UsageRequest{
		{
			RequestID:     "request_" + name + "_1",
			SessionID:     turn.SessionID,
			InputID:       turn.InputID,
			UserID:        userID,
			WorkspaceID:   turn.WorkspaceID,
			DeviceID:      turn.DeviceID,
			Entry:         turn.Entry,
			At:            at.Add(100 * time.Millisecond).Format(time.RFC3339Nano),
			Runtime:       turn.Runtime,
			ProviderLabel: turn.ProviderLabel,
			Model:         model,
			OutputTokens:  10,
			GenerationMs:  1_000,
			FirstTokenMs:  100,
		},
		{
			RequestID:     "request_" + name + "_2",
			SessionID:     turn.SessionID,
			InputID:       turn.InputID,
			UserID:        userID,
			WorkspaceID:   turn.WorkspaceID,
			DeviceID:      turn.DeviceID,
			Entry:         turn.Entry,
			At:            at.Add(200 * time.Millisecond).Format(time.RFC3339Nano),
			Runtime:       turn.Runtime,
			ProviderLabel: turn.ProviderLabel,
			Model:         model,
			OutputTokens:  20,
			GenerationMs:  2_000,
			FirstTokenMs:  300,
		},
	}
	if err := stats.RecordUsage(context.Background(), store.UsageRecord{Turn: &turn, Requests: requests}); err != nil {
		t.Fatal(err)
	}
}

func usageStatsAPIForTest(t *testing.T, handler http.Handler, cookie, path string, status int) store.UsageStatsResult {
	t.Helper()
	response := doAuthCall(t, handler, authCall{
		method: http.MethodGet, path: path, cookie: cookie, origin: accountsTestOrigin,
	})
	expectStatus(t, response, status, "usage stats")
	var result store.UsageStatsResult
	if status == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return result
}
