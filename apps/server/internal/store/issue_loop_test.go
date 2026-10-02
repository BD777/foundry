package store

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestIssueLoopAllowsOnlyItsTransitions(t *testing.T) {
	issue := Issue{Status: "pending"}
	if err := issue.Apply(IssueEventExecutionFinished, nil); !errors.As(err, &ErrIssueTransition{}) || issue.Status != "pending" {
		t.Fatalf("a pending Issue finished an execution: %v %s", err, issue.Status)
	}
	if err := issue.Apply(IssueEventExecutionStarted, nil); err != nil || issue.Status != "in_progress" {
		t.Fatal(err, issue.Status)
	}
	if err := issue.Apply(IssueEventExecutionFailed, &IssueBlockedReason{Kind: "needs_input"}); err == nil {
		t.Fatal("a failure blocked with the wrong reason")
	}
	if err := issue.Apply(IssueEventExecutionAsked, &IssueBlockedReason{Kind: "needs_permission", Message: "Deploy?"}); err != nil || issue.Status != "blocked" || issue.BlockedReason.Message != "Deploy?" {
		t.Fatal(err, issue.Status)
	}
	if err := issue.Apply(IssueEventIntegrated, nil); err == nil {
		t.Fatal("a blocked Issue was accepted")
	}
	if err := issue.Apply(IssueEventContinued, nil); err != nil || issue.Status != "pending" || issue.BlockedReason != nil {
		t.Fatal("continuing did not clear the reason", err)
	}
	issue.Status = "accepted"
	if err := issue.Apply(IssueEventAbandoned, nil); err == nil {
		t.Fatal("an accepted Issue was abandoned")
	}
}

// The design doc shows the loop as a table; it must say what the code does.
func TestIssueLoopDocumentationMatchesTheCode(t *testing.T) {
	doc, err := os.ReadFile("../../../../docs/issue-conversation-design.md")
	if err != nil {
		t.Fatal(err)
	}
	rows := map[string]bool{}
	for _, line := range strings.Split(string(doc), "\n") {
		cells := strings.Split(strings.Trim(strings.TrimSpace(line), "|"), "|")
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		rows[strings.Join(cells, "|")] = true
	}
	for _, step := range IssueLoop {
		row := fmt.Sprintf("`%s`|%s|%s|%s", step.Event, strings.Join(step.From, ", "), step.To, strings.Join(step.Reasons, ", "))
		if !rows[row] {
			t.Errorf("docs/issue-conversation-design.md lacks the loop row %q", row)
		}
	}
}
