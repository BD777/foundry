package skilltools

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestRepositoryToolDeclarationChecksPathsAndBins(t *testing.T) {
	valid := store.SkillToolDeclaration{
		Source: "repository", Command: "olk", Path: "plugins/open-lark",
		Bins: map[string]string{"olk": "bin/olk", "olk-ctx": "bin/olk-ctx"},
	}
	clean, err := CheckDeclarations([]store.SkillToolDeclaration{valid})
	if err != nil || len(clean) != 1 || clean[0].Path != valid.Path {
		t.Fatalf("valid repository tool: %+v, %v", clean, err)
	}
	bad := []store.SkillToolDeclaration{
		{Source: "repository", Command: "olk", Path: "../outside", Bins: map[string]string{"olk": "bin/olk"}},
		{Source: "repository", Command: "olk", Path: "plugins/open-lark", Bins: map[string]string{"olk": "../../bin/olk"}},
		{Source: "repository", Command: "olk", Path: "plugins/open-lark", Bins: map[string]string{"other": "bin/olk"}},
		{Source: "repository", Command: "olk", Path: "plugins/open-lark", Bins: map[string]string{}},
		{Source: "npm", Package: "x", Command: "x", Path: "plugins"},
	}
	for _, tool := range bad {
		if _, err := CheckDeclarations([]store.SkillToolDeclaration{tool}); err == nil {
			t.Fatalf("accepted invalid declaration %+v", tool)
		}
	}
}

func TestRepositoryToolUsesTheBundleCommitAndUpstream(t *testing.T) {
	commit := strings.Repeat("a", 40)
	repo := store.SkillRepository{
		URL: "https://github.com/nwverse/open-lark", Commit: commit,
		DeclaredTools: []store.SkillToolDeclaration{{
			Source: "repository", Command: "olk", Path: "plugins/open-lark",
			Bins: map[string]string{"olk": "bin/olk", "olk-ctx": "bin/olk-ctx"},
		}},
	}
	tools, err := (Resolver{}).WithDeclared(context.Background(), nil, repo, nil, "main@abc1234")
	if err != nil || len(tools) != 1 {
		t.Fatalf("tools %+v, %v", tools, err)
	}
	tool := tools[0]
	if tool.Source != "repository" || tool.Version != commit ||
		tool.Repository != repo.URL || tool.Path != "plugins/open-lark" ||
		tool.Bins["olk-ctx"] != "bin/olk-ctx" {
		t.Fatalf("repository tool %+v", tool)
	}
}
