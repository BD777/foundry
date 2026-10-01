package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// clarify asks the clarification session about the current draft and has it
// answer with reply, as the worker would.
func clarify(t *testing.T, db *Store, issueID, message, reason, key string, reply *store.ClarificationResponse) (store.Issue, store.AgentSession) {
	t.Helper()
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	current, err := db.GetIssue(ctx, issueID)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := db.contractByRevision(ctx, issueID, *current.DraftContractRevision)
	if err != nil {
		t.Fatal(err)
	}
	asked, session, err := db.AskClarification(ctx, store.AskClarificationInput{IssueID: issueID, Revision: draft.Revision, ContentDigest: draft.ContentDigest, Message: message, ChangeReason: reason}, owner, key)
	if err != nil {
		t.Fatal(err)
	}
	if asked.Clarification == nil || asked.Clarification.Status != "replying" || session.Role != store.AgentSessionRoleIssueClarification || session.Input.Prompt != message {
		t.Fatalf("message was not queued to the clarification session: %+v %+v", asked.Clarification, session)
	}
	if _, err = db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if reply == nil {
		session, err = db.FailAgentSession(ctx, session.ID, "provider unavailable")
	} else {
		session, err = db.CompleteAgentSession(ctx, session.ID, reply.Message, "native-1")
	}
	if err != nil {
		t.Fatal(err)
	}
	answered, err := db.AnswerClarification(ctx, session, reply)
	if err != nil {
		t.Fatal(err)
	}
	return answered, session
}

func TestClarificationPreservesHumanConfirmationBoundary(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerForOwnershipTest(t, db, "dev_clarify", "ws_clarify")
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_clarify", SourceInput: "hi", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	current, first := clarify(t, db, issue.ID, "Help define this", "Clarify the target", "question", &store.ClarificationResponse{Message: "What observable result should the Issue deliver?"})
	if current.Status != "blocked" || current.CurrentContractRevision != nil || len(current.Messages) != 2 || current.Clarification.Status != "answered" {
		t.Fatal("clarification launched execution or lost dialogue")
	}
	if first.DeviceID != "dev_clarify" || first.Source != "issue" || first.IssueID != issue.ID {
		t.Fatalf("clarification session is not the Issue's: %+v", first)
	}
	if _, err = db.ClaimNextIssue(ctx, "worker", issue.WorkspaceID); err == nil {
		t.Fatal("claimed unconfirmed clarification")
	}
	content := store.ContractContentOf(draft)
	_, criterion := reviewFixture()
	criterion.Title = "Valid HTTP responses"
	criterion.Statement = "Valid input returns 200 and invalid input returns 400"
	criterion.ProofKind = "functional"
	criterion.Rubric = store.RichContent{Text: "Compare actual request and response", Media: []store.ReferenceMedia{}}
	criterion.EvidenceRequirements[0].Description = "Actual HTTP exchange"
	content.Goal.Text = "Fix API validation"
	content.Criteria = []store.AcceptanceCriterion{criterion}
	reply := store.ClarificationResponse{Message: "The proposed contract is ready for your review, not confirmed.", ProposedContent: &content}
	current, second := clarify(t, db, issue.ID, "Valid 200; invalid 400", "Specify status behavior", "proposal", &reply)
	if second.ID != first.ID || second.NativeSessionID != "native-1" {
		t.Fatal("the next message did not continue the same clarification session")
	}
	proposal, err := db.contractByRevision(ctx, issue.ID, *current.DraftContractRevision)
	if err != nil {
		t.Fatal(err)
	}
	if proposal.Origin != "agent_proposal" || proposal.CreatedBy.Kind != "agent" || proposal.Confirmation != nil || current.CurrentContractRevision != nil {
		t.Fatal("proposal impersonated human confirmation")
	}
	if current.Title != "Fix API validation" {
		t.Fatalf("an Issue named after its raw input takes the proposed goal as its title, got %q", current.Title)
	}
	same := store.ContractContentOf(proposal)
	unchanged, _ := clarify(t, db, issue.ID, "继续", "继续讨论", "no-change", &store.ClarificationResponse{Message: "继续不等于确认，请核对已保存草案。", ProposedContent: &same})
	if *unchanged.DraftContractRevision != proposal.Revision || unchanged.CurrentContractRevision != nil {
		t.Fatal("identical proposal created a revision or confirmed")
	}
	replayed, _, err := db.AskClarification(ctx, store.AskClarificationInput{IssueID: issue.ID, Revision: 1, ContentDigest: draft.ContentDigest, Message: "Valid 200; invalid 400", ChangeReason: "Specify status behavior"}, owner, "proposal")
	if err != nil || len(replayed.Messages) != 3 {
		t.Fatal("clarification replay failed", err)
	}
	if _, _, err = db.AskClarification(ctx, store.AskClarificationInput{IssueID: issue.ID, Revision: 1, ContentDigest: draft.ContentDigest, Message: "Continue", ChangeReason: "Specify status behavior"}, owner, "proposal"); err == nil {
		t.Fatal("changed clarification replay accepted")
	}
	for _, kind := range []string{"agent", "daemon"} {
		if _, err = db.ConfirmContract(ctx, issue.ID, proposal.Revision, proposal.ContentDigest, store.ActorRef{Kind: kind, ID: kind}, "confirm-"+kind); err == nil {
			t.Fatalf("%s confirmed its own proposal", kind)
		}
	}
	confirmed, err := db.ConfirmContract(ctx, issue.ID, proposal.Revision, proposal.ContentDigest, owner, "user-confirms")
	if err != nil || confirmed.Status != "confirmed" {
		t.Fatal("user could not confirm exact proposal", err)
	}
	reason := "用户要求讨论新的完成标准"
	base := confirmed.Revision
	if _, err = db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &base, Content: store.ContractContentOf(confirmed), ChangeReason: &reason}, owner, "begin-amendment"); err != nil {
		t.Fatal(err)
	}
	content.Goal.Text = "Fix validation and explain errors"
	current, _ = clarify(t, db, issue.ID, "建议加上错误说明", reason, "amendment-proposal", &reply)
	if current.CurrentContractRevision == nil || *current.CurrentContractRevision != confirmed.Revision {
		t.Fatal("Agent proposal replaced effective standard before user approval")
	}
	next, err := db.contractByRevision(ctx, issue.ID, *current.DraftContractRevision)
	if err != nil || next.CreatedBy.Kind != "agent" || next.Confirmation != nil {
		t.Fatal("amendment was not an unconfirmed Agent proposal", err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, next.Revision, next.ContentDigest, owner, "user-confirms-amendment"); err != nil {
		t.Fatal(err)
	}
	current, err = db.GetIssue(ctx, issue.ID)
	if err != nil || *current.CurrentContractRevision != next.Revision {
		t.Fatal("user confirmation did not activate new standard", err)
	}
}

func TestFailedClarificationKeepsTheMessageForARetry(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	registerForOwnershipTest(t, db, "dev_retry", "ws_retry")
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_retry", SourceInput: "fix pricing", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	failed, session := clarify(t, db, issue.ID, "What is wrong with pricing?", "Clarify the target", "ask", nil)
	if failed.Clarification.Status != "failed" || failed.Clarification.Error != "provider unavailable" || len(failed.Messages) != 1 || failed.Messages[0].Role != "user" {
		t.Fatalf("a failed reply lost the message or its reason: %+v %+v", failed.Clarification, failed.Messages)
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = db.AskClarification(ctx, store.AskClarificationInput{IssueID: issue.ID, Revision: 1, ContentDigest: draft.ContentDigest, Message: "again", ChangeReason: "x"}, owner, "other"); err != nil {
		t.Fatal("a new message after a failure was refused", err)
	}
	retried, err := db.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = db.RetryClarification(ctx, issue.ID, owner, "retry"); err == nil {
		t.Fatal("retried while the Agent is replying")
	}
	// A late answer to the earlier input settles nothing.
	if late, err := db.AnswerClarification(ctx, session, &store.ClarificationResponse{Message: "late"}); err != nil || len(late.Messages) != len(retried.Messages) || late.Clarification.Status != "replying" {
		t.Fatal("an answer to an earlier input changed the conversation", err)
	}
	current, err := db.GetAgentSession(ctx, retried.Clarification.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.StartAgentSession(ctx, current.ID); err != nil {
		t.Fatal(err)
	}
	if current, err = db.FailAgentSession(ctx, current.ID, "still down"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.AnswerClarification(ctx, current, nil); err != nil {
		t.Fatal(err)
	}
	again, queued, err := db.RetryClarification(ctx, issue.ID, owner, "retry")
	if err != nil || again.Clarification.Status != "replying" || queued.Input.Prompt != "again" || len(again.Messages) != 2 {
		t.Fatal("retry did not send the same message again", err, again.Clarification)
	}
}

func TestConfirmingRevisedStandardSendsVerifyingIssueBackToImplementation(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_revise", SourceInput: "fix pricing", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, criterion := reviewFixture()
	criterion.Title = "Discount is clamped"
	criterion.Statement = "applyDiscount returns 0 above 100 percent"
	criterion.ProofKind = "functional"
	criterion.Rubric = store.RichContent{Text: "Read the delivered file and run the tests", Media: []store.ReferenceMedia{}}
	criterion.EvidenceRequirements[0].Description = "Delivered source file"
	content := store.ContractContentOf(draft)
	content.Goal.Text = "Clamp the discount"
	content.Criteria = []store.AcceptanceCriterion{criterion}
	firstBase := draft.Revision
	firstReason := "用户确认第一版标准"
	first, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &firstBase, Content: content, ChangeReason: &firstReason}, owner, "first-draft")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, first.Revision, first.ContentDigest, owner, "confirm-first"); err != nil {
		t.Fatal(err)
	}
	current, err := db.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The implementation ran and the Issue now waits for acceptance.
	current.Status = "verifying"
	current.Run = &store.Run{ID: "run_1", IssueID: issue.ID, WorkspaceID: current.WorkspaceID, Status: "completed", Runtime: "claude"}
	if err = db.saveIssue(ctx, current, time.Time{}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	base := first.Revision
	reason := "固定检查器无法运行，改为独立 Agent 检查"
	revised := store.ContractContentOf(first)
	revised.Criteria[0].Statement = "applyDiscount returns 0 at and above 100 percent"
	amendment, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &base, Content: revised, ChangeReason: &reason}, owner, "amend")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, amendment.Revision, amendment.ContentDigest, owner, "confirm-amendment"); err != nil {
		t.Fatal(err)
	}
	current, err = db.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Status != "pending" {
		t.Fatalf("a revised standard left the Issue waiting on a stale candidate: %s", current.Status)
	}
	claimed, err := db.ClaimNextIssue(ctx, "worker", issue.WorkspaceID)
	if err != nil || claimed.ID != issue.ID || *claimed.CurrentContractRevision != amendment.Revision {
		t.Fatal("worker could not implement the revised standard", err)
	}
}

func TestConfirmationRejectsDeterministicCriterionWithoutChecker(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_checker", SourceInput: "fix pricing", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, criterion := reviewFixture()
	criterion.Title = "Tests pass"
	criterion.Statement = "node --test reports every case passing"
	criterion.ProofKind = "functional"
	criterion.Rubric = store.RichContent{Text: "Run the project test command", Media: []store.ReferenceMedia{}}
	criterion.EvaluationMode = "deterministic"
	criterion.EvidenceRequirements[0].Description = "Test report"
	content := store.ContractContentOf(draft)
	content.Goal.Text = "Clamp the discount"
	content.Criteria = []store.AcceptanceCriterion{criterion}
	unrunnableBase := draft.Revision
	unrunnableReason := "改为固定检查器"
	unrunnable, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &unrunnableBase, Content: content, ChangeReason: &unrunnableReason}, owner, "draft-unrunnable")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, unrunnable.Revision, unrunnable.ContentDigest, owner, "confirm-unrunnable"); err == nil {
		t.Fatal("confirmed a criterion no checker can ever run")
	}
}

func TestIssueTitleFromGoal(t *testing.T) {
	for goal, want := range map[string]string{
		"Make greet(name) handle blank names. Normal names stay the same.": "Make greet(name) handle blank names",
		"修复空名字的问候。其余不变":                                                    "修复空名字的问候",
		"One line only.":          "One line only",
		"First line\nSecond line": "First line",
		"给 greeting-lib 加一个告别功能：在 greet.mjs 里导出 farewell(name)，写法照着现有的 greet，返回告别语。": "给 greeting-lib 加一个告别功能",
		"Fix bug: parse the date": "Fix bug: parse the date",
	} {
		if got := issueTitleFromGoal(goal); got != want {
			t.Errorf("issueTitleFromGoal(%q) = %q, want %q", goal, got, want)
		}
	}
}
