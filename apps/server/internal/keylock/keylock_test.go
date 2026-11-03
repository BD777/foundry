package keylock

import (
	"sync"
	"testing"
)

func TestLocksSerializeAKeyAndForgetItOnceUnused(t *testing.T) {
	var locks Locks
	var wait sync.WaitGroup
	inside, most := 0, 0
	var count sync.Mutex
	for range 50 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			unlock := locks.Lock("a")
			count.Lock()
			inside++
			most = max(most, inside)
			count.Unlock()
			count.Lock()
			inside--
			count.Unlock()
			unlock()
		}()
	}
	wait.Wait()
	if most != 1 {
		t.Fatalf("%d held key a at once", most)
	}
	unlockB := locks.Lock("b")
	unlockC := locks.Lock("c") // another key does not wait for b
	unlockC()
	unlockB()
	if len(locks.entries) != 0 {
		t.Fatalf("unused keys kept: %v", locks.entries)
	}
}
