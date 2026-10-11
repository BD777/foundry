package eventstream

import (
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type emittedForTest struct {
	mu     sync.Mutex
	values []string
}

func (e *emittedForTest) emit(key string, value []string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	sorted := append([]string(nil), value...)
	sort.Strings(sorted)
	e.values = append(e.values, key+":"+strings.Join(sorted, ","))
}

func (e *emittedForTest) take() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	values := e.values
	e.values = nil
	return values
}

func throttleForTest(window time.Duration, leading bool, emitted *emittedForTest) *Throttle[string, []string] {
	return NewThrottle(ThrottleOptions[string, []string]{
		Window:  func() time.Duration { return window },
		Leading: leading,
		Merge:   func(waiting, next []string) []string { return append(waiting, next...) },
		Emit:    emitted.emit,
	})
}

// With a leading edge, a burst goes out at once, then once more with
// everything that came after, at the end of the window; keys are throttled
// apart, and a key quiet for a window goes out at once again.
func TestThrottleLeadsAndTrails(t *testing.T) {
	emitted := &emittedForTest{}
	throttle := throttleForTest(100*time.Millisecond, true, emitted)
	throttle.Add("a", []string{"1"})
	throttle.Add("a", []string{"2"})
	throttle.Add("a", []string{"3"})
	throttle.Add("b", []string{"x"})
	if got := emitted.take(); !reflect.DeepEqual(got, []string{"a:1", "b:x"}) {
		t.Fatalf("leading edge = %v", got)
	}
	time.Sleep(200 * time.Millisecond)
	if got := emitted.take(); !reflect.DeepEqual(got, []string{"a:2,3"}) {
		t.Fatalf("trailing edge = %v, want the rest of the burst once", got)
	}
	time.Sleep(150 * time.Millisecond)
	throttle.Add("a", []string{"4"})
	if got := emitted.take(); !reflect.DeepEqual(got, []string{"a:4"}) {
		t.Fatalf("after a quiet window = %v, want it at once", got)
	}
}

// Without a leading edge, a burst waits a whole window and goes out once.
func TestThrottleTrailsOnly(t *testing.T) {
	emitted := &emittedForTest{}
	throttle := throttleForTest(100*time.Millisecond, false, emitted)
	throttle.Add("a", []string{"1"})
	throttle.Add("a", []string{"2"})
	if got := emitted.take(); len(got) != 0 {
		t.Fatalf("emitted %v before the window ended", got)
	}
	time.Sleep(200 * time.Millisecond)
	if got := emitted.take(); !reflect.DeepEqual(got, []string{"a:1,2"}) {
		t.Fatalf("end of the window = %v", got)
	}
	throttle.Add("a", []string{"3"})
	if got := emitted.take(); len(got) != 0 {
		t.Fatalf("a later burst emitted %v at once", got)
	}
}
