package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	// subagentListActiveTTL bounds how stale a running session's list may
	// be: a subagent's answer grows on its device between the (coalesced)
	// progress events that invalidate the cache.
	subagentListActiveTTL = 2 * time.Second
	// subagentProgressInterval is how long a list read before a subagent's
	// latest progress report ("Subtask running") is still served. Older
	// workers send several reports a second per subagent, and each one cost
	// readers a full read from the device; a subagent starting, finishing
	// or failing still empties the cache at once.
	subagentProgressInterval = 3 * time.Second
	subagentListTimeout      = 15 * time.Second
	// subagentReadWait is how long a reader waits for the device read it
	// shares: a little longer than the read, so the read's own timeout,
	// which names the device, is what the reader gets.
	subagentReadWait    = subagentListTimeout + time.Second
	subagentListEntries = 256
	// subagentFailureMemory is how long a device that did not answer a
	// list read in time is not asked again for the session: each reader
	// would send it a request of its own, and on a slow link every late
	// answer adds to what the device is behind on.
	subagentFailureMemory = 30 * time.Second
	// subagentEndedTasks bounds the ended tasks a session's entry keeps.
	subagentEndedTasks = 1024
)

// subagentListCache answers a session's subagent list from memory while no
// subagent event arrived since it was read from the device, and lets
// concurrent readers share one device round trip. Readers poll the list
// often; each read used to cost a request to the device.
type subagentListCache struct {
	mu      sync.Mutex
	entries map[string]*subagentListEntry
}

type subagentListEntry struct {
	// revision rises when one of the session's subagents starts, finishes
	// or fails; progress rises with each of their progress reports.
	revision uint64
	progress uint64
	body     []byte
	// bodyRevision and bodyProgress are what body was read at.
	bodyRevision uint64
	bodyProgress uint64
	readAt       time.Time
	used         time.Time
	inflight     *subagentListCall
	// tasks are the session's tasks seen starting that have not ended, by
	// id: whether each is a subagent. End events do not name a task's type.
	tasks map[string]bool
	// ended are the session's tasks seen ending, by id: how each ended. The
	// same end again, or the start arriving after it, changes nothing; a
	// list read says what they ended as (see run).
	ended map[string]subagentEnd
	// failure is the last list read the device did not answer in time,
	// remembered until failedAt+subagentFailureMemory.
	failure  error
	failedAt time.Time
}

type subagentListCall struct {
	done     chan struct{}
	revision uint64
	progress uint64
	body     []byte
	err      error
}

func newSubagentListCache() *subagentListCache {
	return &subagentListCache{entries: map[string]*subagentListEntry{}}
}

// invalidate marks what was read of the session's subagents out of date.
func (c *subagentListCache) invalidate(sessionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry := c.entries[sessionID]; entry != nil {
		entry.revision++
	}
}

// progressed marks what was read of the session's subagents as behind a
// progress report: still served until subagentProgressInterval old.
func (c *subagentListCache) progressed(sessionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry := c.entries[sessionID]; entry != nil {
		entry.progress++
	}
}

// subagentChange is what a session event changed in the session's
// subagent list.
type subagentChange int

const (
	subagentUnchanged subagentChange = iota
	// subagentStarted: a subagent started; its event names it in full.
	subagentStarted
	// subagentEnded: a subagent finished or failed.
	subagentEnded
	// subagentTaskEnded: a task the server did not see start ended; it is a
	// subagent only if its device lists it.
	subagentTaskEnded
	// subagentUntypedStart: a task started without its type (workers before
	// they sent it); it may be a subagent.
	subagentUntypedStart
)

// subagentTaskType is the task type of Claude's subagents; its devices list
// only these.
const subagentTaskType = "local_agent"

// observe updates the cache for a stored session event and says what the
// event changed in the session's list.
func (c *subagentListCache) observe(event store.AgentSessionEvent) subagentChange {
	if !subagentEvent(event) {
		return subagentUnchanged
	}
	if subagentProgressLabels[event.Label] {
		c.progressed(event.SessionID)
		return subagentUnchanged
	}
	taskID, taskType := event.Metadata.TaskID, event.Metadata.TaskType
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.entries[event.SessionID]
	if entry == nil {
		c.evict()
		entry = &subagentListEntry{used: time.Now()}
		c.entries[event.SessionID] = entry
	}
	if ended, seen := entry.ended[taskID]; seen && (ended.label == event.Label || subagentStartLabels[event.Label]) {
		return subagentUnchanged
	}
	if subagentStartLabels[event.Label] {
		if taskType == "" {
			entry.revision++
			return subagentUntypedStart
		}
		if subagent, open := entry.tasks[taskID]; open && subagent == (taskType == subagentTaskType) {
			return subagentUnchanged
		}
		if entry.tasks == nil {
			entry.tasks = map[string]bool{}
		}
		entry.tasks[taskID] = taskType == subagentTaskType
		if taskType != subagentTaskType {
			return subagentUnchanged
		}
		entry.revision++
		return subagentStarted
	}
	subagent, seen := entry.tasks[taskID]
	delete(entry.tasks, taskID)
	if entry.ended == nil || len(entry.ended) >= subagentEndedTasks {
		entry.ended = map[string]subagentEnd{}
	}
	entry.ended[taskID] = subagentEnd{label: event.Label, usage: event.Metadata.SubagentUsage, revision: entry.revision + 1}
	if !seen && taskType != "" {
		subagent, seen = taskType == subagentTaskType, true
	}
	if seen && !subagent {
		return subagentUnchanged
	}
	entry.revision++
	if seen {
		return subagentEnded
	}
	return subagentTaskEnded
}

// load returns the session's list encoded as JSON. fetch runs at most once
// at a time per session, detached from any one reader, so a reader that
// gives up does not fail the others.
func (c *subagentListCache) load(ctx context.Context, sessionID string, active bool, fetch func(context.Context) ([]store.AgentSubagentSummary, error)) ([]byte, error) {
	c.mu.Lock()
	entry := c.entries[sessionID]
	if entry == nil {
		c.evict()
		entry = &subagentListEntry{}
		c.entries[sessionID] = entry
	}
	now := time.Now()
	entry.used = now
	age := now.Sub(entry.readAt)
	if entry.body != nil && entry.bodyRevision == entry.revision &&
		(!active || age < subagentListActiveTTL) &&
		(entry.bodyProgress == entry.progress || age < subagentProgressInterval) {
		body := entry.body
		c.mu.Unlock()
		return body, nil
	}
	call := entry.inflight
	// A read that started before a subagent's start or end may not have it.
	if call == nil || call.revision != entry.revision {
		if entry.failure != nil && now.Sub(entry.failedAt) < subagentFailureMemory {
			err := entry.failure
			c.mu.Unlock()
			return nil, err
		}
		call = &subagentListCall{done: make(chan struct{}), revision: entry.revision, progress: entry.progress}
		entry.inflight = call
		go c.run(sessionID, entry, call, fetch)
	}
	c.mu.Unlock()
	select {
	case <-call.done:
		return call.body, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *subagentListCache) run(sessionID string, entry *subagentListEntry, call *subagentListCall, fetch func(context.Context) ([]store.AgentSubagentSummary, error)) {
	ctx, cancel := context.WithTimeout(context.Background(), subagentListTimeout)
	defer cancel()
	subagents, err := fetch(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	var body []byte
	if err == nil {
		body, err = json.Marshal(entry.withEnds(subagents, call.revision))
	}
	call.body, call.err = body, err
	if entry.inflight == call {
		entry.inflight = nil
	}
	switch {
	case err == nil:
		entry.failure = nil
	case errors.Is(err, context.DeadlineExceeded):
		entry.failure, entry.failedAt = err, time.Now()
	}
	if err == nil && c.entries[sessionID] == entry && (entry.body == nil || call.revision >= entry.bodyRevision) {
		entry.body, entry.bodyRevision, entry.bodyProgress, entry.readAt = body, call.revision, call.progress, time.Now()
	}
	close(call.done)
}

// subagentEnd is how a task ended, as its end event said, and the list
// revision its end made.
type subagentEnd struct {
	label    string
	usage    *store.SubagentUsage
	revision uint64
}

// withEnds is the device's list, read at revision, with each subagent the
// server saw end by then ended as its event said, with what it used: the
// device's transcript may lag behind the event. Callers hold mu.
func (entry *subagentListEntry) withEnds(subagents []store.AgentSubagentSummary, revision uint64) []store.AgentSubagentSummary {
	for index, subagent := range subagents {
		end, ended := entry.ended[subagent.TaskID]
		status := subagentEndStatus[end.label]
		if !ended || status == "" || end.revision > revision {
			continue
		}
		subagents[index].Status = status
		if end.usage != nil {
			subagents[index].Usage = end.usage
		}
	}
	return subagents
}

// evict drops the least recently read session once the cache is full.
// Callers hold mu.
func (c *subagentListCache) evict() {
	if len(c.entries) < subagentListEntries {
		return
	}
	oldestID := ""
	var oldest time.Time
	for id, entry := range c.entries {
		if entry.inflight != nil {
			continue
		}
		if oldestID == "" || entry.used.Before(oldest) {
			oldestID, oldest = id, entry.used
		}
	}
	if oldestID != "" {
		delete(c.entries, oldestID)
	}
}

// subagentStartLabels and subagentEndStatus (the status each end leaves)
// are the events that change a subagent's status in the list, and
// subagentProgressLabels those that update its usage while it runs, with
// the labels workers before 0.5.2 wrote. Its growing answer is covered by
// subagentListActiveTTL instead, so streaming text does not empty the cache
// several times a second.
var (
	subagentStartLabels = map[string]bool{"Starting subtask": true, "正在启动子任务": true}
	subagentEndStatus   = map[string]string{
		"Subtask completed": "completed", "Subtask failed": "failed",
		"子任务完成": "completed", "子任务失败": "failed",
	}
	subagentProgressLabels = map[string]bool{"Subtask running": true, "子任务进行中": true}
)

func subagentEvent(event store.AgentSessionEvent) bool {
	return event.Metadata != nil && event.Metadata.TaskID != "" &&
		(subagentStartLabels[event.Label] || subagentEndStatus[event.Label] != "" || subagentProgressLabels[event.Label])
}
