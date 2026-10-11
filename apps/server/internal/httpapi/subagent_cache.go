package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
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

// subagentListView is what a list read answers: the whole list (prompts and
// answers, which agents read) or digests (what a chat shows: answers only as
// fingerprints, no prompts), which its viewers read after every change.
type subagentListView int

const (
	subagentListFull subagentListView = iota
	subagentListDigests
	subagentListViews
)

type subagentListEntry struct {
	// revision rises when one of the session's subagents starts, finishes
	// or fails; progress rises with each of their progress reports.
	revision uint64
	progress uint64
	// reads are what was read of the list, by view.
	reads [subagentListViews]subagentListRead
	used  time.Time
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

// subagentListRead is the list as last read in one view.
type subagentListRead struct {
	body []byte
	// bodyRevision and bodyProgress are what body was read at.
	bodyRevision uint64
	bodyProgress uint64
	readAt       time.Time
	inflight     *subagentListCall
}

// subagentList is a device's list of a session's subagents in one view.
type subagentList interface {
	// encode is the list as JSON, each subagent ended as ended says.
	encode(ended func(taskID string) (subagentEnd, bool)) ([]byte, error)
}

type subagentSummaries []store.AgentSubagentSummary

func (list subagentSummaries) encode(ended func(string) (subagentEnd, bool)) ([]byte, error) {
	for index := range list {
		if end, ok := ended(list[index].TaskID); ok {
			end.apply(&list[index].Status, &list[index].Usage)
		}
	}
	return json.Marshal(list)
}

type subagentDigests []store.AgentSubagentDigest

func (list subagentDigests) encode(ended func(string) (subagentEnd, bool)) ([]byte, error) {
	for index := range list {
		if end, ok := ended(list[index].TaskID); ok {
			end.apply(&list[index].Status, &list[index].Usage)
		}
	}
	return json.Marshal(list)
}

// subagentListViewOf is the view a list request asks for: ?view=digest for
// digests, else the whole list.
func subagentListViewOf(r *http.Request) subagentListView {
	if r.URL.Query().Get("view") == subagentDigestView {
		return subagentListDigests
	}
	return subagentListFull
}

// subagentListFetch reads the session's list in view from its device.
func (h *DaemonHub) subagentListFetch(session store.AgentSession, view subagentListView) func(context.Context) (subagentList, error) {
	return func(ctx context.Context) (subagentList, error) {
		if view == subagentListDigests {
			digests, err := h.ListAgentSubagentDigests(ctx, session)
			return subagentDigests(digests), err
		}
		subagents, err := h.ListAgentSubagents(ctx, session)
		return subagentSummaries(subagents), err
	}
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

// load returns the session's list in view encoded as JSON. fetch runs at
// most once at a time per session and view, detached from any one reader,
// so a reader that gives up does not fail the others.
func (c *subagentListCache) load(ctx context.Context, sessionID string, view subagentListView, active bool, fetch func(context.Context) (subagentList, error)) ([]byte, error) {
	c.mu.Lock()
	entry := c.entries[sessionID]
	if entry == nil {
		c.evict()
		entry = &subagentListEntry{}
		c.entries[sessionID] = entry
	}
	now := time.Now()
	entry.used = now
	read := &entry.reads[view]
	age := now.Sub(read.readAt)
	if read.body != nil && read.bodyRevision == entry.revision &&
		(!active || age < subagentListActiveTTL) &&
		(read.bodyProgress == entry.progress || age < subagentProgressInterval) {
		body := read.body
		c.mu.Unlock()
		return body, nil
	}
	call := read.inflight
	// A read that started before a subagent's start or end may not have it.
	if call == nil || call.revision != entry.revision {
		if entry.failure != nil && now.Sub(entry.failedAt) < subagentFailureMemory {
			err := entry.failure
			c.mu.Unlock()
			return nil, err
		}
		call = &subagentListCall{done: make(chan struct{}), revision: entry.revision, progress: entry.progress}
		read.inflight = call
		go c.run(sessionID, entry, read, call, fetch)
	}
	c.mu.Unlock()
	select {
	case <-call.done:
		return call.body, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *subagentListCache) run(sessionID string, entry *subagentListEntry, read *subagentListRead, call *subagentListCall, fetch func(context.Context) (subagentList, error)) {
	ctx, cancel := context.WithTimeout(context.Background(), subagentListTimeout)
	defer cancel()
	subagents, err := fetch(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	var body []byte
	if err == nil {
		body, err = subagents.encode(func(taskID string) (subagentEnd, bool) {
			return entry.endedBy(taskID, call.revision)
		})
	}
	call.body, call.err = body, err
	if read.inflight == call {
		read.inflight = nil
	}
	switch {
	case err == nil:
		entry.failure = nil
	case errors.Is(err, context.DeadlineExceeded):
		entry.failure, entry.failedAt = err, time.Now()
	}
	if err == nil && c.entries[sessionID] == entry && (read.body == nil || call.revision >= read.bodyRevision) {
		read.body, read.bodyRevision, read.bodyProgress, read.readAt = body, call.revision, call.progress, time.Now()
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

// apply makes a listed subagent's status and usage what its end said.
func (end subagentEnd) apply(status *string, usage **store.SubagentUsage) {
	*status = subagentEndStatus[end.label]
	if end.usage != nil {
		*usage = end.usage
	}
}

// endedBy says how the task ended if the server saw it end by the list
// revision a device read started at: a subagent the read lists ends as its
// event said, with what it used, since the device's transcript may lag
// behind the event. Callers hold mu.
func (entry *subagentListEntry) endedBy(taskID string, revision uint64) (subagentEnd, bool) {
	end, ended := entry.ended[taskID]
	if !ended || subagentEndStatus[end.label] == "" || end.revision > revision {
		return subagentEnd{}, false
	}
	return end, true
}

// reading says whether a device read of the session's list is under way.
func (entry *subagentListEntry) reading() bool {
	for _, read := range entry.reads {
		if read.inflight != nil {
			return true
		}
	}
	return false
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
		if entry.reading() {
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
