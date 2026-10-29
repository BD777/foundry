package externalaccounts_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// restarted is the service a new server process builds over the same
// database: nothing of the first process's memory carries over (DEV-091).
func (h *cfHarness) restarted() *externalaccounts.Service {
	next := externalaccounts.NewService(h.store, h.store, externalaccounts.NewRegistry(h.adapter))
	next.Now = h.service.Now
	return next
}

func callbackProblem(err error) string {
	var problem *externalaccounts.CallbackError
	if errors.As(err, &problem) {
		return problem.Problem
	}
	return ""
}

func TestCloudflareSignInSurvivesServerRestart(t *testing.T) {
	h := newCFHarness(t)
	ctx := context.Background()
	v := h.begin(t, "dialog-one")
	if !h.service.HasSecret(ctx, "external-login:"+v.ID) {
		t.Fatal("the verifier is not sealed for a later process")
	}
	record, err := h.store.GetExternalCodeLogin(ctx, v.ID)
	if err != nil || record.Phase != "authorize" || record.Outcome != "" {
		t.Fatalf("saved sign-in %+v %v", record, err)
	}
	if strings.Contains(record.VerificationURI, "code_verifier") {
		t.Fatal("verifier in the saved row")
	}

	b := h.restarted()
	if view, ok := b.Login(v.ID, "alice"); !ok || view.Status != "pending" || view.Phase != "authorize" || view.VerificationURI != v.VerificationURI {
		t.Fatalf("restarted process lost the dialog's sign-in: %+v %v", view, ok)
	}
	if _, ok := b.Login(v.ID, "bob"); ok {
		t.Fatal("another owner read the sign-in")
	}
	if !b.AuthorizationCodeCallbackAllowed("alice", v.ID, h.adapter.BaseURL) {
		t.Fatal("restarted process refused the callback's provenance")
	}
	if b.AuthorizationCodeCallbackAllowed("bob", v.ID, h.adapter.BaseURL) {
		t.Fatal("provenance exception for another owner")
	}
	// The same dialog asking again is answered with its sign-in, not a second one.
	again, err := b.BeginAuthorizationCode(ctx, "alice", "cloudflare", "dialog-one", "https://foundry.example/api/connectors/cloudflare/oauth/callback")
	if err != nil || again.ID != v.ID {
		t.Fatalf("restart started a second sign-in: %+v %v", again, err)
	}
	if err := b.CompleteAuthorizationCode(ctx, "alice", v.ID, "fixture-code", h.adapter.BaseURL, ""); err != nil {
		t.Fatal(err)
	}
	// The old process, still answering during a handoff, cannot replay it.
	if err := h.service.CompleteAuthorizationCode(ctx, "alice", v.ID, "fixture-code", h.adapter.BaseURL, ""); callbackProblem(err) != externalaccounts.CallbackUsed {
		t.Fatalf("old process replayed a claimed state: %v", err)
	}
	if h.tokens.Load() != 1 {
		t.Fatalf("code exchanged %d times", h.tokens.Load())
	}
	if h.service.HasSecret(ctx, "external-login:"+v.ID) {
		t.Fatal("verifier kept after the callback claimed it")
	}
	var done store.ExternalAccountLogin
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if done, _ = b.Login(v.ID, "alice"); done.Status != "pending" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if done.Status != "complete" || done.Account == nil || done.Account.Subject != "user:fixture" {
		t.Fatalf("not connected after restart: %+v", done)
	}
	// A third process shows how it ended.
	if view, ok := h.restarted().Login(v.ID, "alice"); !ok || view.Status != "complete" || view.Account == nil || view.Account.ID != done.Account.ID {
		t.Fatalf("outcome not kept: %+v", view)
	}
	if err := h.restarted().CompleteAuthorizationCode(ctx, "alice", v.ID, "fixture-code", h.adapter.BaseURL, ""); callbackProblem(err) != externalaccounts.CallbackUsed {
		t.Fatalf("replay after restart: %v", err)
	}
}

func TestCloudflareStaleCallbackReasons(t *testing.T) {
	h := newCFHarness(t)
	ctx := context.Background()
	issuer := h.adapter.BaseURL
	b := h.restarted()
	if problem := b.AuthorizationCodeCallbackProblem("alice", "xlogin_unknown", issuer); problem != externalaccounts.CallbackUnknown {
		t.Fatalf("unknown state: %q", problem)
	}

	closed := h.begin(t, "closed-dialog")
	if err := h.service.CancelAuthorizationCode("alice", closed.ID, "closed-dialog"); err != nil {
		t.Fatal(err)
	}
	if problem := h.restarted().AuthorizationCodeCallbackProblem("alice", closed.ID, issuer); problem != externalaccounts.CallbackClosed {
		t.Fatalf("closed state after restart: %q", problem)
	}
	if problem := h.service.AuthorizationCodeCallbackProblem("alice", closed.ID, issuer); problem != externalaccounts.CallbackClosed {
		t.Fatalf("closed state: %q", problem)
	}
	if err := h.restarted().CancelAuthorizationCode("alice", closed.ID, "closed-dialog"); !errors.Is(err, externalaccounts.ErrLoginGone) {
		t.Fatalf("closing an ended sign-in again: %v", err)
	}
	if err := h.restarted().CancelAuthorizationCode("alice", "xlogin_missing", "any"); !errors.Is(err, externalaccounts.ErrLoginGone) {
		t.Fatalf("closing a missing sign-in: %v", err)
	}

	pending := h.begin(t, "pending-dialog")
	if problem := h.restarted().AuthorizationCodeCallbackProblem("bob", pending.ID, issuer); problem != externalaccounts.CallbackOtherAccount {
		t.Fatalf("other owner: %q", problem)
	}
	if problem := h.restarted().AuthorizationCodeCallbackProblem("alice", pending.ID, "https://wrong.invalid"); problem != externalaccounts.CallbackIssuer {
		t.Fatalf("wrong issuer: %q", problem)
	}
	// A connection change in one process supersedes it for every process.
	if err := h.store.SupersedeExternalCodeLogins(ctx, "alice", "cloudflare"); err != nil {
		t.Fatal(err)
	}
	if err := h.restarted().CompleteAuthorizationCode(ctx, "alice", pending.ID, "fixture-code", issuer, ""); callbackProblem(err) != externalaccounts.CallbackSuperseded {
		t.Fatalf("superseded state after restart: %v", err)
	}
	if err := h.service.CompleteAuthorizationCode(ctx, "alice", pending.ID, "fixture-code", issuer, ""); callbackProblem(err) != externalaccounts.CallbackSuperseded {
		t.Fatalf("superseded state in the old process: %v", err)
	}

	expiring := h.begin(t, "slow-dialog")
	h.clock.Add(int64(11 * time.Minute))
	if problem := h.restarted().AuthorizationCodeCallbackProblem("alice", expiring.ID, issuer); problem != externalaccounts.CallbackExpired {
		t.Fatalf("expired state after restart: %q", problem)
	}
	if view, ok := h.restarted().Login(expiring.ID, "alice"); !ok || view.Status != "failed" {
		t.Fatalf("expired sign-in view: %+v", view)
	}
	if h.tokens.Load() != 0 {
		t.Fatal("a stale callback reached the provider")
	}
}

// A restart while the client was still being prepared leaves no link to
// follow; the dialog is told to start again instead of waiting forever.
func TestCloudflareSignInInterruptedBeforeAuthorize(t *testing.T) {
	h := newCFHarness(t)
	ctx := context.Background()
	if err := h.store.SaveExternalCodeLogin(ctx, store.ExternalCodeLogin{
		ID: "xlogin_interrupted", Provider: "cloudflare", OwnerUserID: "alice", RequestID: "dialog", Phase: "register",
		RedirectURI: "https://foundry.example/api/connectors/cloudflare/oauth/callback", Issuer: h.adapter.BaseURL,
		ExpiresAt: time.Unix(0, h.clock.Load()).Add(10 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	view, ok := h.restarted().Login("xlogin_interrupted", "alice")
	if !ok || view.Status != "failed" || !strings.Contains(view.Error, "restart") {
		t.Fatalf("interrupted preparation: %+v %v", view, ok)
	}
	fresh, err := h.restarted().BeginAuthorizationCode(ctx, "alice", "cloudflare", "dialog", "https://foundry.example/api/connectors/cloudflare/oauth/callback")
	if err != nil || fresh.ID == "xlogin_interrupted" {
		t.Fatalf("a new attempt reused the interrupted sign-in: %+v %v", fresh, err)
	}
}
