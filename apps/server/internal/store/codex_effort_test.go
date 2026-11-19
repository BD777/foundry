package store

import (
	"strings"
	"testing"
)

func TestValidCodexEffortAcceptsWhatCodexCatalogsAdvertise(t *testing.T) {
	// Values the installed Codex 0.163.0 model/list advertises, plus minimal,
	// which saved settings may still carry.
	for _, effort := range []string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"} {
		if !ValidCodexEffort(effort) {
			t.Fatalf("%q is rejected, but Codex advertises it", effort)
		}
	}
}

func TestValidCodexEffortRejectsMalformedValues(t *testing.T) {
	for _, effort := range []string{"", "Extra High", "high ", "a\nb", "x/y", strings.Repeat("a", 65)} {
		if ValidCodexEffort(effort) {
			t.Fatalf("%q is accepted as a Codex effort", effort)
		}
	}
}
