package store

import (
	"fmt"
	"slices"
)

// IssueEvent is something that moves an Issue through its loop. Every status
// change of an Issue is one of these events; IssueLoop is the one definition
// of where each may happen and where it leads (docs/issue-conversation-design.md
// mirrors it).
type IssueEvent string

const (
	// The clarification Agent replied; the person answers or confirms next.
	IssueEventClarificationReplied IssueEvent = "clarification_replied"
	// A confirmed contract was (re)confirmed while a finished candidate waited;
	// the Issue goes back to implementation.
	IssueEventContractConfirmed IssueEvent = "contract_confirmed"
	// An execution session started implementing the confirmed contract.
	IssueEventExecutionStarted IssueEvent = "execution_started"
	// The execution's turn ended with a candidate to review.
	IssueEventExecutionFinished IssueEvent = "execution_finished"
	// The execution's turn ended on a question for the person.
	IssueEventExecutionAsked IssueEvent = "execution_asked"
	// The person stopped the execution; the candidate is kept.
	IssueEventExecutionStopped IssueEvent = "execution_stopped"
	// The execution failed; the candidate is kept for a retry.
	IssueEventExecutionFailed IssueEvent = "execution_failed"
	// The person continued the Issue: feedback, an answer or a retry.
	IssueEventContinued IssueEvent = "continued"
	// The accepted review integrated into the workspace.
	IssueEventIntegrated IssueEvent = "integrated"
	// The person abandoned the Issue; history and candidate are kept.
	IssueEventAbandoned IssueEvent = "abandoned"
)

// IssueTransition is where an event may happen and where it leads. A blocked
// destination needs one of the listed reasons.
type IssueTransition struct {
	From    []string
	To      string
	Reasons []string
}

// IssueLoop is the Issue state machine, in the order the docs show it.
var IssueLoop = []struct {
	Event IssueEvent
	IssueTransition
}{
	{IssueEventClarificationReplied, IssueTransition{From: []string{"pending", "blocked"}, To: "blocked", Reasons: []string{"needs_input"}}},
	{IssueEventContractConfirmed, IssueTransition{From: []string{"blocked", "verifying"}, To: "pending"}},
	{IssueEventExecutionStarted, IssueTransition{From: []string{"pending"}, To: "in_progress"}},
	{IssueEventExecutionFinished, IssueTransition{From: []string{"in_progress"}, To: "verifying"}},
	{IssueEventExecutionAsked, IssueTransition{From: []string{"in_progress"}, To: "blocked", Reasons: []string{"needs_input", "needs_permission"}}},
	{IssueEventExecutionStopped, IssueTransition{From: []string{"in_progress"}, To: "blocked", Reasons: []string{"needs_input"}}},
	{IssueEventExecutionFailed, IssueTransition{From: []string{"in_progress"}, To: "blocked", Reasons: []string{"system_error"}}},
	{IssueEventContinued, IssueTransition{From: []string{"pending", "blocked", "verifying"}, To: "pending"}},
	{IssueEventIntegrated, IssueTransition{From: []string{"verifying"}, To: "accepted"}},
	{IssueEventAbandoned, IssueTransition{From: []string{"pending", "blocked", "verifying"}, To: "abandoned"}},
}

// ErrIssueTransition refuses an event the Issue's current status does not allow.
type ErrIssueTransition struct {
	Event IssueEvent
	From  string
}

func (e ErrIssueTransition) Error() string {
	return fmt.Sprintf("illegal_issue_transition: %s cannot happen while the Issue is %s", e.Event, e.From)
}

// Apply moves the Issue by the event. A blocked destination takes the reason;
// leaving blocked clears it.
func (issue *Issue) Apply(event IssueEvent, reason *IssueBlockedReason) error {
	for _, step := range IssueLoop {
		if step.Event != event {
			continue
		}
		if !slices.Contains(step.From, issue.Status) {
			return ErrIssueTransition{Event: event, From: issue.Status}
		}
		if step.To == "blocked" {
			if reason == nil || !slices.Contains(step.Reasons, reason.Kind) {
				return fmt.Errorf("illegal_issue_transition: %s needs a reason of %v", event, step.Reasons)
			}
			issue.BlockedReason = reason
		} else {
			issue.BlockedReason = nil
		}
		issue.Status = step.To
		return nil
	}
	return fmt.Errorf("illegal_issue_transition: unknown event %s", event)
}
