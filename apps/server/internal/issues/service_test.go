package issues

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// toldForTest records what the service tells, as "kind issue-status".
type toldForTest struct{ told []string }

func (r *toldForTest) Created(issue store.Issue)                        { r.told = append(r.told, "created "+issue.Status) }
func (r *toldForTest) Updated(issue store.Issue)                        { r.told = append(r.told, "updated "+issue.Status) }
func (r *toldForTest) EvidenceChanged(store.Issue, string, int, string) {}

// take is what was told since the last take.
func (r *toldForTest) take() []string {
	told := r.told
	r.told = nil
	return told
}

// devicesForTest is a connected device whose candidate may always change.
type devicesForTest struct{}

func (devicesForTest) Connected(string) bool                           { return true }
func (devicesForTest) Git(context.Context, string, bool) (bool, error) { return false, nil }
func (devicesForTest) CheckRetry(context.Context, store.Issue) error   { return nil }
func (devicesForTest) Dispatch(store.AgentSession) error               { return nil }
func (devicesForTest) ClaimReady()                                     {}

func serviceForTest(t *testing.T) (*Service, *toldForTest, *sqlitestore.Store) {
	t.Helper()
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device: store.DeviceProjection{ID: "dev_issues"}, Workspace: store.WorkspaceProjection{ID: "ws_issues"},
	}); err != nil {
		t.Fatal(err)
	}
	told := &toldForTest{}
	return New(db, told, devicesForTest{}), told, db
}

var ownerForTest = Actor{ActorRef: store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}}

// Each change of an Issue tells who follows Issues once, with the Issue as
// it is now: viewers and observers hear of every entry's changes alike.
func TestEveryMutationTellsObserversOnce(t *testing.T) {
	svc, told, db := serviceForTest(t)
	ctx := context.Background()
	created, err := svc.Create(ctx, ownerForTest, store.CreateIssueInput{WorkspaceID: "ws_issues", SourceInput: "Add usage", Runtime: "mock"}, CreateOptions{RequestID: "create"})
	if err != nil {
		t.Fatal(err)
	}
	issue := created.Issue
	step := func(what string, want string, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		if got := told.take(); len(got) != 1 || got[0] != want {
			t.Fatalf("%s told %v, want [%s]", what, got, want)
		}
	}
	step("create", "created pending", nil)
	testfixture.ConfirmContract(t, db, issue.ID)
	_, err = svc.AskStatus(ctx, issue.ShortID, "status?", "status")
	step("status question", "updated pending", err)
	execution := store.AgentSession{ID: "sess_run", IssueID: issue.ID, Role: store.AgentSessionRoleIssueExecution, Provider: "mock"}
	svc.Observer().SessionChanged(ctx, sessions.Started, execution)
	step("execution start", "updated in_progress", nil)
	svc.Settle(ctx, execution, &store.CompleteIssueInput{Response: "Done"}, nil)
	step("execution end", "updated verifying", nil)
	_, err = svc.Continue(ctx, ownerForTest, issue.ID, "Also a badge", "sess_run")
	step("continue", "updated pending", err)
	draft := 2
	reason := "Narrow the request"
	contract, err := svc.SaveDraft(ctx, ownerForTest, issue.ID, store.ContractDraftInput{BaseRevision: &draft, ChangeReason: &reason, Content: contentForTest()}, "draft")
	step("draft", "updated pending", err)
	_, err = svc.Confirm(ctx, ownerForTest, issue.ID, contract.Revision, contract.ContentDigest, "confirm")
	step("confirm", "updated pending", err)
	_, err = svc.Abandon(ctx, ownerForTest, issue.ID, "sess_run")
	step("abandon", "updated abandoned", err)
	if _, err := svc.Continue(ctx, ownerForTest, issue.ID, "again", ""); err == nil || len(told.take()) != 0 {
		t.Fatal("a refused change was told", err)
	}
}

// A lock taken by an Issue's id holds a request that names it by its short
// id.
func TestShortAndLongIDShareTheLock(t *testing.T) {
	svc, _, db := serviceForTest(t)
	ctx := context.Background()
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_issues", SourceInput: "Lock", Runtime: "mock"})
	if err != nil {
		t.Fatal(err)
	}
	unlock := svc.Lock(issue.ID)
	done := make(chan error, 1)
	go func() {
		_, err := svc.AskStatus(ctx, issue.ShortID, "status?", "short")
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("a request by short id went past the lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	unlock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func contentForTest() store.ContractContent {
	return store.ContractContent{
		Goal: store.RichContent{Text: "Add usage", Media: []store.ReferenceMedia{}}, InScope: []string{}, OutOfScope: []string{}, Constraints: []string{},
		Criteria: []store.AcceptanceCriterion{{
			ID: "criterion_usage", Title: "Usage", Statement: "The README explains usage", Required: true,
			ProofKind: "content_completeness", EvaluationMode: "agent", Rubric: store.RichContent{Text: "Read the README", Media: []store.ReferenceMedia{}},
			EvidenceRequirements: []store.EvidenceRequirement{{ID: "requirement_usage", Description: "The README", AcceptedCarriers: []store.CarrierKind{"document"}, MinimumCount: 1, BindingPolicy: "system_observed"}},
		}},
	}
}

// A person's message goes where it is due, whichever entry sends it: a
// question about where the Issue stands is answered; then the answer to the
// question it waits on (its deciders only), its clarification while a draft
// waits, feedback once it has a candidate. A closed or executing Issue
// takes none of these.
func TestMessageRoutesLikeTheWebDid(t *testing.T) {
	svc, _, db := serviceForTest(t)
	ctx := context.Background()
	member := Actor{ActorRef: ownerForTest.ActorRef, UserID: "user_member", Role: store.WorkspaceRoleMember}
	maintainer := Actor{ActorRef: ownerForTest.ActorRef, UserID: "user_maintainer", Role: store.WorkspaceRoleMaintainer}
	send := func(issueID, text string, by Actor) (Route, store.Issue, error) {
		t.Helper()
		return svc.Message(ctx, by, issueID, Message{Text: text, Key: text})
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_issues", SourceInput: "Add usage", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if route, _, err := send(issue.ID, "现在是什么状态？", member); err != nil || route != RouteStatus {
		t.Fatalf("a status question went to %q: %v", route, err)
	}
	route, asked, err := send(issue.ID, "For new users", member)
	if err != nil || route != RouteClarify || asked.Clarification == nil {
		t.Fatalf("a message about the draft went to %q: %v", route, err)
	}
	if asked.Clarification.ChangeReason != "Clarification: For new users" {
		t.Fatalf("a message naming no reason is recorded as %q", asked.Clarification.ChangeReason)
	}
	clarification, err := db.StartAgentSession(ctx, asked.Clarification.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	svc.Settle(ctx, clarification, nil, &store.ClarificationResponse{Message: "Noted."})

	testfixture.ConfirmContract(t, db, issue.ID)
	_, session, err := db.ClaimIssueExecution(ctx, "dev_issues", "ws_issues")
	if err != nil {
		t.Fatal(err)
	}
	if session, err = db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	svc.Observer().SessionChanged(ctx, sessions.Started, session)
	if _, _, err := send(issue.ID, "Also a badge", maintainer); !errors.Is(err, ErrExecuting) {
		t.Fatalf("an executing Issue took a message: %v", err)
	}
	if _, err := svc.Ask(ctx, session.ID, store.IssueQuestion{Kind: "input", Text: "Which README?"}); err != nil {
		t.Fatal(err)
	}
	svc.Settle(ctx, session, &store.CompleteIssueInput{Response: "Waiting for the person."}, nil)
	if _, _, err := send(issue.ID, "The root one", member); !errors.Is(err, ErrMayNotDecide) {
		t.Fatalf("a member who did not create the Issue answered its question: %v", err)
	}
	if route, answered, err := send(issue.ID, "The root one", maintainer); err != nil || route != RouteAnswer || answered.Question != nil {
		t.Fatalf("the answer went to %q: %v", route, err)
	}

	verifying, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_issues", SourceInput: "Fix the badge", Runtime: "mock"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, verifying.ID)
	run := store.AgentSession{ID: "sess_badge", IssueID: verifying.ID, Role: store.AgentSessionRoleIssueExecution}
	svc.Observer().SessionChanged(ctx, sessions.Started, run)
	svc.Settle(ctx, run, &store.CompleteIssueInput{Response: "Done"}, nil)
	if route, continued, err := send(verifying.ID, "Make it blue", member); err != nil || route != RouteContinue || continued.Status != "pending" {
		t.Fatalf("feedback went to %q: %v", route, err)
	}
	if _, err := db.AbandonIssue(ctx, verifying.ID, run.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := send(verifying.ID, "One more thing", member); !errors.Is(err, ErrClosed) {
		t.Fatalf("a closed Issue took a message: %v", err)
	}
}

// offlineForTest is a device that is not connected.
type offlineForTest struct{ devicesForTest }

func (offlineForTest) Connected(string) bool { return false }

// An Issue starts clarifying its request when it is created, whichever entry
// creates it; a device that cannot take it leaves the Issue created, with
// why.
func TestCreateStartsClarifying(t *testing.T) {
	svc, _, db := serviceForTest(t)
	ctx := context.Background()
	input := store.CreateIssueInput{WorkspaceID: "ws_issues", SourceInput: "Add usage", Runtime: "claude"}
	created, err := svc.Create(ctx, ownerForTest, input, CreateOptions{RequestID: "online"})
	if err != nil || created.ClarifyError != nil {
		t.Fatal(err, created.ClarifyError)
	}
	if clarification := created.Issue.Clarification; clarification == nil || clarification.Status != "replying" || created.Issue.Messages[0].Text != "Add usage" {
		t.Fatalf("the Issue did not start clarifying its request: %+v", created.Issue)
	}
	offline := New(db, &toldForTest{}, offlineForTest{})
	created, err = offline.Create(ctx, ownerForTest, input, CreateOptions{RequestID: "offline"})
	if err != nil || created.Issue.ID == "" || created.ClarifyError == nil || created.Issue.Clarification != nil {
		t.Fatalf("an offline device: %+v %v", created, err)
	}
}

// A status question is recognized in either language, and only as a whole
// message about the Issue.
func TestStatusQuestionsInEitherLanguage(t *testing.T) {
	for text, want := range map[string]bool{
		"这里是什么状态？": true, "继续": false, "What is the status?": true, "any update": true,
		"状态接口缺少参数时返回400": false,
	} {
		if statusQuestion.MatchString(text) != want {
			t.Errorf("%q: status question %v, want %v", text, !want, want)
		}
	}
}
