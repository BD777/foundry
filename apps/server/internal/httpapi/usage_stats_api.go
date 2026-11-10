package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/usagestats"
)

func (s *Server) handleGetUsageStats(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	now := time.Now().UTC()
	from, err := usageTimeBoundary(query.Get("from"), now.Add(-7*24*time.Hour), false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	to, err := usageTimeBoundary(query.Get("to"), now, true)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	granularity := strings.TrimSpace(query.Get("granularity"))
	if granularity == "" {
		granularity = "day"
	}
	if granularity != "hour" && granularity != "day" {
		writeError(w, http.StatusBadRequest, "granularity must be hour or day")
		return
	}
	groupBy := []string{"entry", "model"}
	if _, present := query["groupBy"]; present {
		groupBy = splitUsageValues(query["groupBy"])
	}
	limit, err := usageIntParam(query.Get("limit"), 100, 500)
	if err != nil {
		writeError(w, http.StatusBadRequest, "limit must be a positive integer")
		return
	}
	offset, err := usageIntParam(query.Get("offset"), 0, 1_000_000)
	if err != nil {
		writeError(w, http.StatusBadRequest, "offset must be a non-negative integer")
		return
	}
	scope, err := s.requestScope(r)
	if err != nil || scope.userID == "" {
		writeError(w, http.StatusForbidden, "An account is required.")
		return
	}
	userID := strings.TrimSpace(query.Get("userId"))
	if !scope.admin {
		if userID != "" && userID != scope.userID {
			writeForbidden(w, "Only the instance Admin can read another person's usage.")
			return
		}
		userID = scope.userID
	}
	if s.hub.usageStats == nil {
		writeError(w, http.StatusServiceUnavailable, "usage statistics are unavailable")
		return
	}
	result, err := s.hub.usageStats.Query(r.Context(), usagestats.QueryOptions{
		Granularity: granularity,
		GroupBy:     groupBy,
		Limit:       limit,
		Offset:      offset,
		Filter: store.UsageStatsFilter{
			From:        from,
			To:          to,
			UserID:      userID,
			Entry:       query.Get("entry"),
			DeviceID:    query.Get("deviceId"),
			WorkspaceID: query.Get("workspaceId"),
			Provider:    query.Get("provider"),
			Model:       query.Get("model"),
			Runtime:     query.Get("runtime"),
		},
	})
	if errors.Is(err, usagestats.ErrInvalidQuery) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query usage statistics")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func usageTimeBoundary(raw string, fallback time.Time, endOfDay bool) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return parsed.UTC(), nil
	}
	if parsed, err := time.Parse("2006-01-02", raw); err == nil {
		if endOfDay {
			parsed = parsed.Add(24 * time.Hour)
		}
		return parsed.UTC(), nil
	}
	return time.Time{}, errors.New("time boundaries must be RFC 3339 or YYYY-MM-DD")
}

func usageIntParam(raw string, fallback, maximum int) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > maximum {
		return 0, errors.New("out of range")
	}
	if value == 0 && fallback > 0 {
		return fallback, nil
	}
	return value, nil
}

func splitUsageValues(values []string) []string {
	var result []string
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if part = strings.TrimSpace(part); part != "" {
				result = append(result, part)
			}
		}
	}
	return result
}
