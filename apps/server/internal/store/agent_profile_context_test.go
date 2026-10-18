package store

import (
	"encoding/json"
	"testing"
)

func TestDeviceContextWindowClearSurvivesDispatch(t *testing.T) {
	raw, err := json.Marshal(CreateAgentProfileInput{ContextWindows: map[string]int64{}})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["contextWindows"]) != "{}" {
		t.Fatalf("explicit clear was lost in dispatch: %s", raw)
	}
}
