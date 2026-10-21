package connectors

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func settledAuthorization(t *testing.T, d *DeviceHeld, device, scope string) store.DeviceConnectorSignIn {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		slot := d.authorization(device, scope)
		slot.mu.Lock()
		running, answer := slot.running, slot.answer
		slot.mu.Unlock()
		if !running {
			return answer
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("authorization work did not finish")
	return store.DeviceConnectorSignIn{}
}

func TestAuthorizationImmediateReceiptIdentityAndRecovery(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	d := &DeviceHeld{Now: func() time.Time { return time.Unix(0, clock.Load()) }}
	release := make(chan struct{})
	entered := make(chan struct{})
	var calls atomic.Int32
	run := func(id, phase string, progress func(string)) (store.DeviceConnectorSignIn, error) {
		calls.Add(1)
		close(entered)
		<-release
		progress("starting")
		return store.DeviceConnectorSignIn{}, errors.New("lost native begin receipt")
	}
	first, err := d.Authorize("alice", "device", "kind", "request-a", "", true, run)
	if err != nil || first.OperationID == "" || first.Phase != "checking" {
		t.Fatalf("receipt: %+v %v", first, err)
	}
	<-entered
	for i := 0; i < 10; i++ {
		again, err := d.Authorize("alice", "device", "kind", "request-a", "", true, run)
		if err != nil || again.OperationID != first.OperationID {
			t.Fatal("lost receipt replayed begin")
		}
	}
	for _, s := range [][3]string{{"bob", "device", "kind"}, {"alice", "other", "kind"}, {"alice", "device", "group2"}} {
		if _, err = d.Authorize(s[0], s[1], s[2], "", first.OperationID, false, run); err != ErrAuthorizationOperation {
			t.Fatal("scope escaped")
		}
	}
	close(release)
	result := settledAuthorization(t, d, "device", "kind")
	if result.Status != "pending" || result.Phase != "starting" || result.Error == "" {
		t.Fatalf("uncertain result: %+v", result)
	}
	clock.Add(int64(3 * time.Second))
	_, err = d.Authorize("alice", "device", "kind", "", first.OperationID, false, func(id, phase string, progress func(string)) (store.DeviceConnectorSignIn, error) {
		if phase != "starting" || id != first.OperationID {
			t.Error("recovery lost dispatch phase")
		}
		return store.DeviceConnectorSignIn{Status: "pending", Phase: "awaiting_user", VerificationURL: "https://login.example/challenge"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	result = settledAuthorization(t, d, "device", "kind")
	if result.VerificationURL == "" || calls.Load() != 1 {
		t.Fatal("recovery restarted grant")
	}
	clock.Add(int64(11 * time.Minute))
	expired, _ := d.Authorize("alice", "device", "kind", "", first.OperationID, false, run)
	if expired.Status != "expired" || expired.VerificationURL != "" {
		t.Fatalf("expiry %+v", expired)
	}
	restarted := &DeviceHeld{Now: time.Now}
	if _, err = restarted.Authorize("alice", "device", "kind", "", first.OperationID, false, run); err != ErrAuthorizationOperation {
		t.Fatal("restart accepted unknown operation")
	}
}

func TestConcurrentAuthorizationAndLateCompletion(t *testing.T) {
	d := &DeviceHeld{Now: time.Now}
	var calls atomic.Int32
	release := make(chan struct{})
	var wg sync.WaitGroup
	ids := make(chan string, 20)
	run := func(_, _ string, _ func(string)) (store.DeviceConnectorSignIn, error) {
		calls.Add(1)
		<-release
		return store.DeviceConnectorSignIn{Status: "complete"}, nil
	}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, e := d.Authorize("alice", "d", "k", "req", "", true, run)
			if e != nil {
				t.Error(e)
			}
			ids <- a.OperationID
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for next := range ids {
		if id != "" && id != next {
			t.Fatal("duplicate operation")
		}
		id = next
	}
	if err := d.Dismiss("alice", "d", "k", id); err != nil {
		t.Fatal(err)
	}
	next, _ := d.Authorize("alice", "d", "k", "new", "", true, func(_, _ string, _ func(string)) (store.DeviceConnectorSignIn, error) {
		return store.DeviceConnectorSignIn{Status: "pending", VerificationURL: "https://new.example/approve"}, nil
	})
	close(release)
	a := settledAuthorization(t, d, "d", "k")
	if a.OperationID != next.OperationID || a.Status != "pending" || a.VerificationURL != "https://new.example/approve" {
		t.Fatalf("late completion overwrote new attempt: %+v", a)
	}
	_ = d.InvalidateAuthorization("d", "k", func() error { return nil })
	if _, err := d.Authorize("alice", "d", "k", "", next.OperationID, false, run); err != ErrAuthorizationOperation {
		t.Fatal("invalidated operation resumed")
	}
}

func TestAuthorizationImageScopeExpiryAndDismissal(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	d := &DeviceHeld{Now: func() time.Time { return time.Unix(0, clock.Load()) }}
	scope := "bytedcli\x00web_session\x001"
	start := func(_, _ string, _ func(string)) (store.DeviceConnectorSignIn, error) {
		return store.DeviceConnectorSignIn{Status: "pending", Challenge: &store.ConnectorAuthorizationChallenge{Kind: "qr_image"}, Image: []byte("fixture-image")}, nil
	}
	a, err := d.Authorize("alice", "mac", scope, "request", "", true, start)
	if err != nil {
		t.Fatal(err)
	}
	settledAuthorization(t, d, "mac", scope)
	if data, err := d.AuthorizationImage("alice", "mac", scope, a.OperationID); err != nil || string(data) != "fixture-image" {
		t.Fatal(err)
	}
	for _, s := range [][3]string{{"bob", "mac", scope}, {"alice", "other", scope}, {"alice", "mac", "bytedcli"}, {"alice", "mac", "bytedcli\x00web_session\x002"}} {
		if _, err := d.AuthorizationImage(s[0], s[1], s[2], a.OperationID); err != ErrAuthorizationOperation {
			t.Fatal("image scope escaped")
		}
	}
	if err := d.Dismiss("bob", "mac", scope, a.OperationID); err != ErrAuthorizationOperation {
		t.Fatal(err)
	}
	if err := d.Dismiss("alice", "mac", scope, a.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := d.AuthorizationImage("alice", "mac", scope, a.OperationID); err != ErrAuthorizationOperation {
		t.Fatal("dismissed image visible")
	}
	b, _ := d.Authorize("alice", "mac", scope, "next", "", true, start)
	settledAuthorization(t, d, "mac", scope)
	clock.Add(int64(11 * time.Minute))
	if _, err := d.AuthorizationImage("alice", "mac", scope, b.OperationID); err != ErrAuthorizationOperation {
		t.Fatal("expired image visible")
	}
}
