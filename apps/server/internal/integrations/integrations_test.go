package integrations

import (
	"errors"
	"testing"
)

func TestParse(t *testing.T) {
	for value, on := range map[string]bool{"": true, "on": true, " ON ": true, "off": false, "Off": false} {
		sw, err := Parse(value)
		if err != nil || sw.On() != on {
			t.Fatalf("Parse(%q) = on %v, %v; want on %v", value, sw.On(), err, on)
		}
	}
	for _, value := range []string{"0", "false", "disabled"} {
		if _, err := Parse(value); err == nil {
			t.Fatalf("Parse(%q) accepted", value)
		}
	}
}

func TestNilSwitchIsOn(t *testing.T) {
	var sw *Switch
	if !sw.On() || sw.Err() != nil {
		t.Fatal("a nil switch must be on")
	}
	if err := New(false).Err(); !errors.Is(err, ErrOff) {
		t.Fatalf("off switch answers %v", err)
	}
}
