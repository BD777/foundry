package flow

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestInboxIdentityDoesNotMergeUsersChannelsOrBoundaries(t *testing.T) {
	cases := [][]string{
		{"person-a", "web", "message-1"},
		{"person-b", "web", "message-1"},
		{"person-a", "feishu", "message-1"},
		{"person-a", "web", "message-2"},
		{"person", "a:web", "message-1"},
	}
	seen := map[string]bool{}
	for _, parts := range cases {
		key := Key("inbox", parts...)
		if seen[key] {
			t.Fatal("different sources collapsed")
		}
		seen[key] = true
		if key != Key("inbox", parts...) {
			t.Fatal("a retry changed identity")
		}
		if !store.ValidSessionInputID(InputID(key)) || InputID(key) != InputID(key) {
			t.Fatal("outbox input identity is not a stable native UUID")
		}
	}
	if Key("inbox", "a", "bc") == Key("inbox", "ab", "c") {
		t.Fatal("component boundaries collapsed")
	}
}

func TestDependencyDiamondAndInvalidGraph(t *testing.T) {
	valid := map[string][]string{
		"research": {}, "design": {"research"}, "review": {"research"},
		"deliver": {"design", "review"},
	}
	if err := CheckDependencies(valid); err != nil {
		t.Fatal(err)
	}
	for name, graph := range map[string]map[string][]string{
		"cycle":   {"a": {"b"}, "b": {"c"}, "c": {"a"}},
		"self":    {"a": {"a"}},
		"missing": {"a": {"someone-elses-item"}},
		"repeat":  {"a": {"b", "b"}, "b": {}},
	} {
		t.Run(name, func(t *testing.T) {
			if CheckDependencies(graph) == nil {
				t.Fatal("invalid graph was accepted")
			}
		})
	}
}

func TestCaptureRejectsUnsupportedSourceAndEmptyMessage(t *testing.T) {
	if err := Capture("person-a", "web", "message-1", "记一下这件事"); err != nil {
		t.Fatal(err)
	}
	for _, parts := range [][4]string{
		{"", "web", "m1", "task"}, {"a", "model", "m1", "task"},
		{"a", "web", "", "task"}, {"a", "web", "m1", " \n "},
	} {
		if Capture(parts[0], parts[1], parts[2], parts[3]) == nil {
			t.Fatal("invalid source was accepted")
		}
	}
}
