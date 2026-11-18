package personalagent

import (
	"strings"
	"testing"
)

// The class of a channel update follows its fields: the name and pausing are
// immediate; anything that widens what a channel reads or writes is a proposal.
func TestChannelPatchClassFollowsTheFields(t *testing.T) {
	for label, tc := range map[string]struct {
		patch map[string]string
		want  SettingsClass
	}{
		"rename":        {map[string]string{"name": `"Ops"`}, SettingsImmediate},
		"pause":         {map[string]string{"enabled": "false"}, SettingsImmediate},
		"pause, rename": {map[string]string{"enabled": "false", "name": `"Ops"`}, SettingsImmediate},
		"resume":        {map[string]string{"enabled": "true"}, SettingsProposal},
		"guide":         {map[string]string{"guide": `"be brief"`}, SettingsProposal},
		"filters":       {map[string]string{"filters": `{"rules":[]}`}, SettingsProposal},
		"resume flag":   {map[string]string{"resumeFromNow": "true"}, SettingsProposal},
	} {
		got, err := ChannelPatchClass(tc.patch)
		if err != nil || got != tc.want {
			t.Errorf("%s: class %q (%v), want %q", label, got, err, tc.want)
		}
	}
}

// A patch mixing the two classes, an unknown field and an empty patch are refused.
func TestChannelPatchClassRefusesMixedUnknownAndEmpty(t *testing.T) {
	if _, err := ChannelPatchClass(map[string]string{"enabled": "false", "guide": `"x"`}); err == nil || !strings.Contains(err.Error(), "separate update") {
		t.Errorf("mixed patch: %v", err)
	}
	if _, err := ChannelPatchClass(map[string]string{"owner": `"x"`}); err == nil || !strings.Contains(err.Error(), "not a channel setting") {
		t.Errorf("unknown field: %v", err)
	}
	if _, err := ChannelPatchClass(map[string]string{}); err == nil {
		t.Errorf("empty patch was accepted")
	}
}

// Every operation has a class, and grant-source is the person's.
func TestChannelOpClassesNameEveryOperation(t *testing.T) {
	want := map[string]string{
		"list": ChannelOpRead, "peers": ChannelOpRead, "test": ChannelOpRead,
		"create": ChannelOpProposal, "update": ChannelOpByPatch, "grant-source": ChannelOpRefused,
	}
	if len(ChannelOpClasses) != len(want) {
		t.Errorf("classes = %v", ChannelOpClasses)
	}
	for op, class := range want {
		if ChannelOpClasses[op] != class {
			t.Errorf("%s class %q, want %q", op, ChannelOpClasses[op], class)
		}
	}
}

func TestChannelProposalSummaryNamesTheChange(t *testing.T) {
	if got := ChannelProposalSummary("zh", "create", "运维群", nil); !strings.Contains(got, "运维群") || !strings.Contains(got, "新增") {
		t.Errorf("create summary %q", got)
	}
	if got := ChannelProposalSummary("en", "update", "Ops", []string{"guide", "enabled"}); got != `Shall I change the message channel "Ops": enabled, guide?` {
		t.Errorf("update summary %q", got)
	}
}
