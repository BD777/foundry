// Package keylock serializes work per key.
package keylock

import "sync"

// Locks holds one mutex per key while someone holds or waits for it, so
// keys that come and go (sessions, workspaces, requests) do not pile up.
// The zero value is ready to use.
type Locks struct {
	mu      sync.Mutex
	entries map[string]*entry
}

type entry struct {
	sync.Mutex
	// users is how many hold or wait for the mutex; Locks.mu guards it.
	users int
}

// Lock waits until no one else holds key, takes it and returns the func
// that releases it, which must be called once.
func (l *Locks) Lock(key string) (unlock func()) {
	l.mu.Lock()
	if l.entries == nil {
		l.entries = map[string]*entry{}
	}
	held, ok := l.entries[key]
	if !ok {
		held = &entry{}
		l.entries[key] = held
	}
	held.users++
	l.mu.Unlock()
	held.Lock()
	return func() {
		held.Unlock()
		l.mu.Lock()
		held.users--
		if held.users == 0 {
			delete(l.entries, key)
		}
		l.mu.Unlock()
	}
}
