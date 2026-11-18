package sqlitestore

import (
	"context"
	"testing"
	"time"
)

func TestFormatTimeWritesNineFractionDigitsAsUTC(t *testing.T) {
	cases := []struct {
		name string
		at   time.Time
		want string
	}{
		{"whole second", time.Date(2026, 10, 23, 5, 0, 0, 0, time.UTC), "2026-10-23T05:00:00.000000000Z"},
		{"trailing zeros kept", time.Date(2026, 10, 23, 5, 0, 0, 591470000, time.UTC), "2026-10-23T05:00:00.591470000Z"},
		{"nanoseconds", time.Date(2026, 10, 23, 5, 0, 0, 591471234, time.UTC), "2026-10-23T05:00:00.591471234Z"},
		{"other zone written as UTC", time.Date(2026, 10, 23, 13, 0, 0, 0, time.FixedZone("CST", 8*3600)), "2026-10-23T05:00:00.000000000Z"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatTime(tc.at); got != tc.want {
				t.Fatalf("formatTime = %q, want %q", got, tc.want)
			}
		})
	}
	earlier := formatTime(time.Date(2026, 10, 23, 5, 0, 0, 591470000, time.UTC))
	later := formatTime(time.Date(2026, 10, 23, 5, 0, 0, 591471000, time.UTC))
	if earlier >= later {
		t.Fatalf("text order %q >= %q: the earlier time must sort first", earlier, later)
	}
}

// Legacy rows hold trimmed fractions. Text sorts ".59147Z" after ".591471Z"
// though it is earlier, so the edge picks must compare the second's rows by time.
func TestTimeEdgeRowIDPicksByParsedTimeWithinASecond(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	if _, err := db.conn().ExecContext(ctx, `CREATE TABLE edge_probe (grp TEXT NOT NULL, at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ grp, at string }{
		{"a", "2026-10-23T05:00:00.591471Z"},    // rowid 1: the latest
		{"a", "2026-10-23T05:00:00.59147Z"},     // rowid 2: the earliest, trimmed
		{"a", "2026-10-23T05:00:00.591470000Z"}, // rowid 3: the same instant as rowid 2
		{"b", "2026-10-23T04:59:59.9Z"},         // another group, earlier
	} {
		if _, err := db.conn().ExecContext(ctx, `INSERT INTO edge_probe (grp, at) VALUES (?, ?)`, row.grp, row.at); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name   string
		where  string
		args   []any
		newest bool
		wantID int64
		found  bool
	}{
		{"newest of a", "grp = ?", []any{"a"}, true, 1, true},
		{"oldest of a, ties to the lower rowid", "grp = ?", []any{"a"}, false, 2, true},
		{"newest of b", "grp = ?", []any{"b"}, true, 4, true},
		{"nothing matches", "grp = ?", []any{"c"}, true, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rowID, found, err := timeEdgeRowID(ctx, db.conn(), "edge_probe", "at", tc.where, tc.args, tc.newest)
			if err != nil {
				t.Fatal(err)
			}
			if found != tc.found || rowID != tc.wantID {
				t.Fatalf("rowID, found = %d, %v; want %d, %v", rowID, found, tc.wantID, tc.found)
			}
		})
	}
}

func TestTimeEdgeRowIDRejectsMalformedTimes(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	if _, err := db.conn().ExecContext(ctx, `CREATE TABLE edge_probe (grp TEXT NOT NULL, at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO edge_probe (grp, at) VALUES ('a', 'soon')`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := timeEdgeRowID(ctx, db.conn(), "edge_probe", "at", "grp = ?", []any{"a"}, true); err == nil {
		t.Fatal("a stored time that is not RFC3339 must fail the pick, not be skipped")
	}
}

// sameInstant reports whether the stored RFC3339 text at is the instant want,
// whatever its fraction width.
func sameInstant(at string, want time.Time) bool {
	parsed, err := time.Parse(time.RFC3339Nano, at)
	return err == nil && parsed.Equal(want)
}
