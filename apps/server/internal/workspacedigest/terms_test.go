package workspacedigest

import (
	"reflect"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Terms are names: hosts, services, code names and file names, lower-cased;
// not common words, numbers, versions, Foundry ids, hashes or secrets.
func TestCountTermsKeepsNamesOnly(t *testing.T) {
	counts := CountTerms([]string{
		"ssh sats-tokyo-7 and restart CLIProxyAPI on the AWS box.",
		"Then check tokyo9, the L1 maker and deploy.sh v1.2.3 — 2026 was fine.",
		"see sess_0123456789abcdef and commit 3f9a2c1d8e and 550e8400-e29b-41d4-a716-446655440000",
		"token sk-abcdefghijklmnopqrstuvwxyz123456 here",
		"sats-tokyo-7 again",
	})
	want := map[string]int{"sats-tokyo-7": 2, "ssh": 1, "restart": 1, "cliproxyapi": 1, "aws": 1, "box": 1, "tokyo9": 1, "l1": 1, "maker": 1, "deploy.sh": 1, "deploy": 0, "commit": 1, "token": 1, "fine": 1}
	for term, count := range want {
		if counts[term] != count {
			t.Errorf("%s counted %d, want %d", term, counts[term], count)
		}
	}
	for term := range counts {
		if _, ok := want[term]; !ok {
			t.Errorf("unexpected term %q", term)
		}
	}
}

// Only the latest maxTermTextBytes of a source are counted.
func TestCountTermsReadsTheLatestText(t *testing.T) {
	old := "oldname " + strings.Repeat("x ", maxTermTextBytes)
	counts := CountTerms([]string{old, "newname"})
	if counts["oldname"] != 0 || counts["newname"] != 1 {
		t.Fatalf("counts = oldname %d newname %d", counts["oldname"], counts["newname"])
	}
}

func TestQueryTerms(t *testing.T) {
	for query, want := range map[string][]string{
		"ssh sats-tokyo-7":  {"ssh", "sats-tokyo-7"},
		"$ccm-harness:spec": {"ccm-harness", "spec"},
		"L1 maker 那段对话 L1":  {"l1", "maker"},
		"东京那台":              {},
		"the":               {},
	} {
		if got := QueryTerms(query); !reflect.DeepEqual(got, want) {
			t.Errorf("QueryTerms(%q) = %q, want %q", query, got, want)
		}
	}
}

// A project file names what sets a project apart: a name most projects
// mention is not one, and a name in several of its chats ranks above one
// repeated in one.
func TestRankMentionsPrefersDistinctiveNames(t *testing.T) {
	totals := []store.WorkspaceTermTotal{
		{WorkspaceID: "ws_a", Term: "zspread2", Count: 40, Sources: 8},
		{WorkspaceID: "ws_a", Term: "pasted", Count: 40, Sources: 1},
		{WorkspaceID: "ws_a", Term: "docker", Count: 50, Sources: 9},
		{WorkspaceID: "ws_b", Term: "docker", Count: 5, Sources: 2},
		{WorkspaceID: "ws_c", Term: "docker", Count: 5, Sources: 2},
		{WorkspaceID: "ws_b", Term: "cliproxyapi", Count: 3, Sources: 2},
	}
	mentions := rankMentions(totals, 4)
	if want := []Mention{{"zspread2", 40}, {"pasted", 40}}; !reflect.DeepEqual(mentions["ws_a"], want) {
		t.Fatalf("ws_a = %+v, want %+v", mentions["ws_a"], want)
	}
	if want := []Mention{{"cliproxyapi", 3}}; !reflect.DeepEqual(mentions["ws_b"], want) {
		t.Fatalf("ws_b = %+v, want %+v", mentions["ws_b"], want)
	}
}

func TestSkillFolder(t *testing.T) {
	for root, want := range map[string]string{
		"/home/me/workspace/ccm/.agents/skills": "/home/me/workspace/ccm",
		"/home/me/workspace/.claude/skills/":    "/home/me/workspace",
		"/opt/skills":                           "/opt",
	} {
		if got := skillFolder(root); got != want {
			t.Errorf("skillFolder(%q) = %q, want %q", root, got, want)
		}
	}
}

// What redact.Text takes out of a text never becomes a term: values after
// password, token and login markers, e-mail addresses and user@host, a
// credential after an auth scheme, a host's address after ssh, a login
// after "User" and private keys.
func TestCountTermsLeavesWhatRedactTakesOut(t *testing.T) {
	counts := CountTerms([]string{
		"password: hunter2x, API_TOKEN=plainvalue1, user=alice9",
		"mail cwindeng@foxmail.com or ssh ubuntu@gpubox",
		"Authorization: Bearer opaquecredential",
		"ssh dev.example.app then ssh sats-tokyo-7",
		"Host gpu\n  HostName hiddenhost\n  User ec2-user",
		"-----BEGIN OPENSSH PRIVATE KEY-----\nkeymaterialword\n-----END OPENSSH PRIVATE KEY-----",
		"AKIAIOSFODNN7EXAMPLE 203.0.113.9",
	})
	for _, leaked := range []string{"hunter2x", "plainvalue1", "alice9", "cwindeng", "foxmail.com", "ubuntu", "gpubox", "opaquecredential", "dev.example.app", "hiddenhost", "ec2-user", "keymaterialword", "akiaiosfodnn7example"} {
		if counts[leaked] != 0 {
			t.Errorf("%q became a term", leaked)
		}
	}
	for _, kept := range []string{"sats-tokyo-7", "gpu", "mail", "authorization"} {
		if counts[kept] == 0 {
			t.Errorf("%q was left out: %v", kept, counts)
		}
	}
}
