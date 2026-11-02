package httpapi

import (
	"context"
	"strings"
	"testing"
)

func TestMCPInstructionsStateTheContractWithinClientLimits(t *testing.T) {
	server := NewServer(newTestStore(t))
	got := server.mcpInstructions(context.Background(), Actor{})
	for _, want := range []string{"$FOUNDRY_SESSION_ID", "list_resources", "$FOUNDRY_BROWSER_BIN", ".foundry/attachments/", "Connectors"} {
		if !strings.Contains(got, want) {
			t.Errorf("instructions lack %q:\n%s", want, got)
		}
	}
	// Claude Code keeps 4,096 characters; Codex summarizes from the first 512.
	if len(got) > 4096 {
		t.Errorf("instructions are %d characters, more than Claude Code keeps", len(got))
	}
	if first, _, _ := strings.Cut(got, "\n"); len([]rune(first)) > 512 {
		t.Errorf("the first paragraph is %d characters, more than Codex's summary", len([]rune(first)))
	}
	if strings.Contains(got, "system account is shared") {
		t.Error("a caller that is not a session is told about a shared account")
	}
}

func TestSharedSystemAccountInstructionNamesEveryone(t *testing.T) {
	if got := sharedSystemAccountInstruction([]string{"Alice"}); !strings.Contains(got, "Alice also uses it") {
		t.Fatalf("one: %s", got)
	}
	if got := sharedSystemAccountInstruction([]string{"Alice", "Bob", "Carol"}); !strings.Contains(got, "Alice, Bob and Carol also use it") {
		t.Fatalf("several: %s", got)
	}
}
