package eventstream

import (
	"sync"
	"time"
)

// Throttle coalesces what is said about a key into at most one emission per
// window. With a leading edge, the first value of a quiet key goes out at
// once; values arriving within the window after an emission wait, merged,
// and go out once at its end, so the last is never left unsaid. Without
// one, every value waits a whole window from the first of its burst.
type Throttle[K comparable, V any] struct {
	options ThrottleOptions[K, V]
	mu      sync.Mutex
	sent    map[K]time.Time
	waiting map[K]V
}

// ThrottleOptions say how a Throttle coalesces.
type ThrottleOptions[K comparable, V any] struct {
	// Window is the most often one key emits; read with every value, so it
	// may change.
	Window func() time.Duration
	// Leading emits the first value of a quiet key at once.
	Leading bool
	// Merge folds a value into the one waiting for its key.
	Merge func(waiting, next V) V
	// Emit sends a key's value, without the throttle's lock: on the
	// caller's goroutine at the leading edge, on a timer's at the end.
	Emit func(key K, value V)
}

func NewThrottle[K comparable, V any](options ThrottleOptions[K, V]) *Throttle[K, V] {
	return &Throttle[K, V]{options: options, sent: map[K]time.Time{}, waiting: map[K]V{}}
}

// Add says value about key.
func (t *Throttle[K, V]) Add(key K, value V) {
	t.mu.Lock()
	if waiting, ok := t.waiting[key]; ok {
		t.waiting[key] = t.options.Merge(waiting, value)
		t.mu.Unlock()
		return
	}
	wait := t.options.Window()
	if t.options.Leading {
		wait -= time.Since(t.sent[key])
		if wait <= 0 {
			t.sent[key] = time.Now()
			t.mu.Unlock()
			t.options.Emit(key, value)
			return
		}
	}
	t.waiting[key] = value
	t.mu.Unlock()
	time.AfterFunc(wait, func() { t.flush(key) })
}

// flush emits what waited for key once its window ended.
func (t *Throttle[K, V]) flush(key K) {
	t.mu.Lock()
	value := t.waiting[key]
	delete(t.waiting, key)
	if t.options.Leading {
		t.sent[key] = time.Now()
	}
	t.mu.Unlock()
	t.options.Emit(key, value)
}
