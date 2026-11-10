package sqlitestore

import (
	"context"
	"strings"
	"testing"
)

func TestOutstandingChildTurnsUsesParentIndex(t *testing.T) {
	db := newTestStore(t)
	rows, err := db.conn().QueryContext(context.Background(), `EXPLAIN QUERY PLAN
		SELECT agent_sessions.parent_session_id
		FROM agent_sessions
		WHERE agent_sessions.parent_session_id IN (?, ?)
			AND `+visibleAgentSessionSQL, "parent_a", "parent_b")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(plan, "\n"), "idx_agent_sessions_parent") {
		t.Fatalf("query plan does not use idx_agent_sessions_parent:\n%s", strings.Join(plan, "\n"))
	}
}
