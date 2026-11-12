package sessionalerts

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAlertTextReportsRetryStateWithoutInstructions(t *testing.T) {
	child := store.AgentSession{ID: "sess_child", Title: "worker one", Status: "failed"}
	cases := []struct {
		name string
		code string
		want string
	}{
		{"failed", "model_rate_limit", "Next: no retry scheduled"},
		{"canceled", CodeCanceled, "Next: no retry scheduled"},
		{"quota", CodeModelQuotaExhausted, "Next: no retry scheduled"},
		{"blocked", CodeBlocked, "Next: retrying if the blocking condition clears"},
		{"slot", CodeWaitingSlot, "Next: retrying when a slot frees"},
		{"offline", CodeDeviceOffline, "Next: retrying when the device reconnects"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := AlertText(store.SessionAlert{
				Code: test.code, Detail: "observed failure\non one line", Occurrences: 2,
			}, child)
			for _, want := range []string{
				"sess_child",
				`"worker one"`,
				"Code: " + test.code,
				"Detail: observed failure on one line",
				"Occurrences: 2",
				test.want,
			} {
				if !strings.Contains(got, want) {
					t.Errorf("alert lacks %q:\n%s", want, got)
				}
			}
			for _, unwanted := range []string{"send_message", "switch", "try another", "instead"} {
				if strings.Contains(strings.ToLower(got), unwanted) {
					t.Errorf("alert contains instruction %q:\n%s", unwanted, got)
				}
			}
		})
	}
}
