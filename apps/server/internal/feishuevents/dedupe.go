package feishuevents

import (
	"container/list"
	"time"
)

// seenEvents remembers the event ids an app's connection delivered, so a
// redelivery (Feishu repushes an event it thinks was not acked in time, or
// after a reconnect) is acked again but routed once. It forgets ids after
// ttl, and the oldest beyond capacity. Not safe for concurrent use: the Hub
// holds its lock.
type seenEvents struct {
	ttl      time.Duration
	capacity int
	order    *list.List // of seenEvent, oldest first
	byID     map[string]*list.Element
}

type seenEvent struct {
	id string
	at time.Time
}

func newSeenEvents(ttl time.Duration, capacity int) *seenEvents {
	return &seenEvents{ttl: ttl, capacity: capacity, order: list.New(), byID: map[string]*list.Element{}}
}

// firstTime records id and reports whether it was not seen within ttl. An
// empty id cannot be deduplicated and always counts as new.
func (s *seenEvents) firstTime(id string, now time.Time) bool {
	for front := s.order.Front(); front != nil; front = s.order.Front() {
		oldest := front.Value.(seenEvent)
		if now.Sub(oldest.at) < s.ttl && s.order.Len() < s.capacity {
			break
		}
		s.order.Remove(front)
		delete(s.byID, oldest.id)
	}
	if id == "" {
		return true
	}
	if _, seen := s.byID[id]; seen {
		return false
	}
	s.byID[id] = s.order.PushBack(seenEvent{id: id, at: now})
	return true
}
