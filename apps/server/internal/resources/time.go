package resources

import "time"

// Stored times are RFC 3339 with nanoseconds, in UTC.

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// parseTime reads a stored time; an empty or malformed one is the zero time.
func parseTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
