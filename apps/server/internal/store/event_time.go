package store

import "time"

// EventTimeLayout is the stored and streamed form of a time: RFC3339 in UTC
// with nine fraction digits. RFC3339Nano trims trailing zeros, and times are
// compared as text, so only a fixed width keeps text order equal to time order.
const EventTimeLayout = "2006-01-02T15:04:05.000000000Z07:00"

// CanonicalTime rewrites an RFC3339 time in EventTimeLayout, so a streamed
// event shows the text a later read returns. Text that is not RFC3339 (an
// empty time, for one) is returned unchanged.
func CanonicalTime(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	return parsed.UTC().Format(EventTimeLayout)
}
