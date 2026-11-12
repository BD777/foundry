package httpapi

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMCPInstructionsStateTheContractWithinClientLimits(t *testing.T) {
	server := NewServer(newTestStore(t))
	got := server.mcpInstructions(context.Background(), Actor{})
	for _, want := range []string{"Foundry runs Claude Code and Codex", "foundry skill", "Connected accounts", "Connectors"} {
		if !strings.Contains(got, want) {
			t.Errorf("instructions lack %q:\n%s", want, got)
		}
	}
	if chars := utf8.RuneCountInString(got); chars > mcpInstructionsMaxChars {
		t.Errorf("instructions are %d characters, want at most %d", chars, mcpInstructionsMaxChars)
	}
	if strings.Contains(got, "system account is shared") {
		t.Error("a caller that is not a session is told about a shared account")
	}
}

func TestSharedSystemAccountInstructionNamesEveryone(t *testing.T) {
	if got := sharedSystemAccountInstruction([]string{"Alice"}); !strings.Contains(got, "shared with Alice") {
		t.Fatalf("one: %s", got)
	}
	if got := sharedSystemAccountInstruction([]string{"Alice", "Bob", "Carol"}); !strings.Contains(got, "shared with Alice, Bob and Carol") {
		t.Fatalf("several: %s", got)
	}
	base := strings.Repeat("x", mcpInstructionsMaxChars-80)
	got := appendSharedSystemAccount(base, []string{strings.Repeat("very-long-name", 20)})
	if chars := utf8.RuneCountInString(got); chars > mcpInstructionsMaxChars {
		t.Fatalf("a long shared-account name made %d characters", chars)
	}
	if !strings.Contains(got, "system account is shared with") {
		t.Fatalf("the shared-account boundary was lost:\n%s", got)
	}
}
