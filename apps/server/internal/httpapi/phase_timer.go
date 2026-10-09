package httpapi

import (
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
)

// phaseTimer records how long each step of a slow operation took, so a slow
// request's log line says where the time went.
type phaseTimer struct {
	name    string
	started time.Time
	phases  []string
	marks   []time.Time
}

func newPhaseTimer(name string) *phaseTimer {
	return &phaseTimer{name: name, started: time.Now()}
}

// mark starts the named step; it lasts until the next mark or the end.
func (t *phaseTimer) mark(phase string) {
	t.phases = append(t.phases, phase)
	t.marks = append(t.marks, time.Now())
}

func (t *phaseTimer) logIfSlow(threshold time.Duration) {
	ended := time.Now()
	total := ended.Sub(t.started)
	if total < threshold {
		return
	}
	parts := make([]string, 0, len(t.phases))
	for i, phase := range t.phases {
		next := ended
		if i+1 < len(t.marks) {
			next = t.marks[i+1]
		}
		if took := next.Sub(t.marks[i]); took >= 50*time.Millisecond {
			parts = append(parts, fmt.Sprintf("%s %s", phase, took.Round(time.Millisecond)))
		}
	}
	log.Printf("slow %s: %s total; %s", t.name, total.Round(time.Millisecond), strings.Join(parts, ", "))
}

// largeProjectionBytes is when a workspace projection's size is worth a log
// line naming its biggest parts.
const largeProjectionBytes = 512 << 10

func logProjectionSize(workspaceID string, encoded []byte) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(encoded, &fields) != nil {
		return
	}
	type part struct {
		name string
		size int
	}
	parts := make([]part, 0, len(fields))
	for name, raw := range fields {
		parts = append(parts, part{name, len(raw)})
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].size > parts[j].size })
	shown := make([]string, 0, 6)
	for i := 0; i < len(parts) && i < 6; i++ {
		shown = append(shown, fmt.Sprintf("%s %dKB", parts[i].name, parts[i].size>>10))
	}
	log.Printf("large foundry-data for %s: %dKB; %s", workspaceID, len(encoded)>>10, strings.Join(shown, ", "))
}
