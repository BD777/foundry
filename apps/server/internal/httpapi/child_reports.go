package httpapi

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
	"github.com/google/uuid"
)

// Child reports (DEV-090). When a session an agent created ends a turn,
// Foundry puts what it answered in its parent's inbox as a turn_end
// message, so the parent learns of it without polling. One report per
// child input: the report's id derives from it. A child created with
// reportBack: false does not report; nor does one whose parent is gone,
// archived or stopped, unless it works on an item: its reports then go to
// whoever follows the item, or wait on the item (DEV-324,
// assistant.SignalTarget). A parent that already read the answer (get_session)
// has the report settled as read, and a child whose own message to its parent was its
// final handoff is not reported again. Reports to a parent between turns
// gather briefly, so children that end together start one parent turn. A
// turn that ends while the parent's newer message to the child waits is not
// reported alone: the turn that message starts reports it along with its own.
// A turn the child's own schedule or wake-up started is not reported: the
// child messages its parent from it when there is news.

const (
	// childReportAnswerLimit is how much of the answer a report carries.
	childReportAnswerLimit = 1500
	// childReportReadReason settles a report its parent read elsewhere.
	childReportReadReason = "read_by_parent"
	// childReportSupersededReason settles a report its parent's newer
	// message outdates; the child's next report carries it.
	childReportSupersededReason = "superseded"
	// supersededReportLimit is how much of each outdated report the next
	// one carries, and supersededReportCount how many.
	supersededReportLimit = 600
	supersededReportCount = 3
)

var (
	// childReportHandoffWindow: a message the child sent its parent this
	// close to its turn's end is that turn's handoff. Measured on dev
	// (2026-10-28/29): 47 of 75 child-to-parent messages came 5-24 s before
	// the turn ended with no work after them; every other came 82 s or more
	// before, with tools run since.
	childReportHandoffWindow = 45 * time.Second
	// childReportSpace names the ids of reports.
	childReportSpace = uuid.MustParse("6f1f5d0e-7a52-4c39-9a4e-0d9b5a1c2e90")
)

// childReportInputID is the id of the report of the child's latest input.
func childReportInputID(child store.AgentSession) string {
	return uuid.NewSHA1(childReportSpace, []byte(child.ID+"\x00"+child.Input.ID)).String()
}

// childReportReactions reports a child's ended turn to its parent.
type childReportReactions struct{ s *Server }

// SessionChanged decides from the ended turn itself: Foundry may already
// have started the child's next turn with a waiting message.
func (r childReportReactions) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	if change != sessions.Completed || session.ParentSessionID == "" {
		return
	}
	r.s.reportChildTurn(ctx, session)
}

// childReportTarget is the session the child reports to (or, with
// Queued, the item its report waits on), or why it reports to none.
func (s *Server) childReportTarget(ctx context.Context, child store.AgentSession) (assistant.SignalTarget, string) {
	switch {
	case child.ParentSessionID == "" || child.Input.ID == "":
		return assistant.SignalTarget{}, "no parent"
	// Scheduled runs and Issue sessions answer to their own owners.
	case child.Source != store.SessionSourceAgent && child.Source != store.SessionSourceVerification, child.Role != "":
		return assistant.SignalTarget{}, "not an agent's child"
	}
	if back, err := s.store.ChildReportBack(ctx, child.ID); err == nil && !back {
		return assistant.SignalTarget{}, "reportBack is off"
	}
	// A child on an item reports to whoever follows the item; an adopted
	// task to the conversation that took it over (§7): the assistant may
	// move homes and keep following the same helper.
	target := s.assistant.SignalTarget(ctx, child, child.ParentSessionID)
	if target.ItemID != "" || target.Via == assistant.SignalViaTask {
		return target, ""
	}
	parent, err := s.store.GetAgentSessionSummary(ctx, child.ParentSessionID)
	switch {
	case err != nil:
		return assistant.SignalTarget{}, "the parent is gone"
	case parent.ArchivedAt != "":
		return assistant.SignalTarget{}, "the parent is archived"
	case parent.Status == "canceled":
		return assistant.SignalTarget{}, "the parent was stopped"
	case parent.Role != "" && parent.Role != store.AgentSessionRolePersonalAgent:
		return assistant.SignalTarget{}, "the parent is controlled by its Issue"
	}
	// A helper of the person's assistant reports to the conversation that
	// handed it off, as any child reports to its creator: turn_end is its
	// completion signal, not a separate server notice.
	return target, ""
}

// signalRelation says how the session a child's signal reaches relates to
// the child: its creator, or a session that follows the child's item.
func signalRelation(child store.AgentSession, target assistant.SignalTarget) string {
	if target.ItemID == "" || (target.SessionID != "" && target.SessionID == child.ParentSessionID) {
		return "which this session created"
	}
	return fmt.Sprintf("which works on item %s that this session follows", target.ItemID)
}

// followerSent reports whether sender is the side the child answers to: its
// creator, or the session its signals reach.
func followerSent(sender string, child store.AgentSession, target assistant.SignalTarget) bool {
	return sender != "" && (sender == child.ParentSessionID || sender == target.SessionID)
}

// childReport is the report of the child's turn (child as it ended) for
// the session it reports to, or why the turn has none. target is set
// whenever the child reports at all; a queued target leaves the item's
// SessionID empty.
func (s *Server) childReport(ctx context.Context, child store.AgentSession) (item store.SessionInboxItem, target assistant.SignalTarget, skip string) {
	if target, skip = s.childReportTarget(ctx, child); skip != "" {
		return item, target, skip
	}
	if child.Status != "completed" && child.Status != "failed" {
		return item, target, "status " + child.Status
	}
	// A turn its own schedule or wake-up started reports nothing the
	// parent asked for, unless the parent's message reached it meanwhile.
	if child.Input.TimerFire != nil && !s.childTookParentMessage(ctx, child, target) {
		return item, target, "a timer started the turn"
	}
	return store.SessionInboxItem{
		SessionID: target.SessionID, InputID: childReportInputID(child), SenderSessionID: child.ID,
		Prompt: s.childReportText(child, target), RequestedDelivery: store.DeliveryTurnEnd,
		// The report's structure travels with it (DEV-246): its row names the
		// child and shows its final answer, without reading the report prose.
		InputSource: childReportSource(child, true),
	}, target, ""
}

// childReportSource is the structured source of a child's report: who
// reported, its turn status, and (with answer) the final answer the report
// carries. Released outdated reports have no single answer.
func childReportSource(child store.AgentSession, answer bool) *store.AgentSessionInputSource {
	source := &store.AgentSessionInputSource{
		Kind: "child_report", SessionID: child.ID, Title: child.Title, Status: child.Status,
	}
	if final := strings.TrimSpace(child.Response); answer && final != "" {
		source.Response = textcut.Excerpt(final, childReportAnswerLimit)
	} else if failure := strings.TrimSpace(child.Error); answer && failure != "" {
		source.Response = textcut.Excerpt("Error: "+failure, childReportAnswerLimit)
	}
	return source
}

// childReportText is a compact handoff of the child's turn.
func (s *Server) childReportText(child store.AgentSession, target assistant.SignalTarget) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "%s session %s (%q), %s, finished a turn: %s.\n", sessions.ChildReportPrefix, child.ID, child.Title, signalRelation(child, target), child.Status)
	if link := s.assistant.SessionURL(child); link != "" {
		fmt.Fprintf(&builder, "Link: %s\n", link)
	}
	if failure := strings.TrimSpace(child.Error); failure != "" {
		fmt.Fprintf(&builder, "Error: %s\n", textcut.Excerpt(failure, 300))
	}
	answer := strings.TrimSpace(child.Response)
	switch length := utf8.RuneCountInString(answer); {
	case length == 0:
		builder.WriteString("It gave no final answer.\n")
	case length <= childReportAnswerLimit:
		fmt.Fprintf(&builder, "\nFinal answer:\n%s\n", answer)
	default:
		fmt.Fprintf(&builder, "\nFinal answer (first %d of %d characters; get_session or read_context on %s has the rest):\n%s\n",
			childReportAnswerLimit, length, child.ID, textcut.Excerpt(answer, childReportAnswerLimit))
	}
	return builder.String()
}

// reportChildTurn puts the report of the child's ended turn in the inbox
// of the session it reports to, or keeps it on the child's item while no
// session follows the item, unless there is none or the child handed off
// itself. A turn whose carrier of outdated reports this was, and that
// reports nothing, releases them on their own.
func (s *Server) reportChildTurn(ctx context.Context, child store.AgentSession) {
	item, target, skip := s.childReport(ctx, child)
	if skip == "" {
		skip = s.childHandedOff(ctx, child, target)
	}
	if skip != "" {
		log.Printf("session child report skipped: session=%s child=%s input=%s reason=%q", child.ParentSessionID, child.ID, child.Input.ID, skip)
		if target.SessionID != "" {
			s.releaseSupersededReports(ctx, child, target, "the turn after them did not report: "+skip)
		}
		return
	}
	if target.Queued() {
		s.queueItemSignal(ctx, target, item, "")
		return
	}
	if s.childTurnSuperseded(ctx, child, target) {
		log.Printf("session child report superseded: session=%s child=%s input=%s", target.SessionID, child.ID, child.Input.ID)
		s.sessionService.SettleInboxItem(ctx, item, childReportSupersededReason)
		return
	}
	item.Prompt += s.supersededChildReports(ctx, child, target.SessionID, item.InputID)
	s.admitChildSignal(ctx, child, target, item)
}

// admitChildSignal puts a child's signal in the inbox of the session target
// names, after what waited on the child's item for a session to follow it.
func (s *Server) admitChildSignal(ctx context.Context, child store.AgentSession, target assistant.SignalTarget, item store.SessionInboxItem) {
	s.sendWaitingItemSignals(ctx, target)
	s.admitChildReport(ctx, child, item)
}

func (s *Server) admitChildReport(ctx context.Context, child store.AgentSession, item store.SessionInboxItem) {
	admission, err := s.store.AdmitSessionInboxItem(ctx, item, store.SessionInboxRules{Now: time.Now().UTC(), DedupWindow: sessions.InboxDedupWindow})
	if err != nil {
		log.Printf("report session %s to %s: %v", child.ID, item.SessionID, err)
		return
	}
	if !admission.Duplicate {
		sessions.LogInboxItem("admitted", admission.Item)
		s.sessionService.WakeInbox()
	}
}

// releaseSupersededReports delivers on their own the child's reports its
// follower's messages outdated, once what was to carry them will not: why
// says what happened instead. Nothing is sent when none is outstanding.
func (s *Server) releaseSupersededReports(ctx context.Context, child store.AgentSession, target assistant.SignalTarget, why string) {
	carried := s.supersededChildReports(ctx, child, target.SessionID, "")
	if carried == "" {
		return
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "%s session %s (%q), %s, has turns your newer messages outdated that no later report carried (%s).\n",
		sessions.ChildReportPrefix, child.ID, child.Title, signalRelation(child, target), why)
	if link := s.assistant.SessionURL(child); link != "" {
		fmt.Fprintf(&builder, "Link: %s\n", link)
	}
	builder.WriteString(carried)
	log.Printf("session child report released: session=%s child=%s input=%s why=%q", target.SessionID, child.ID, child.Input.ID, why)
	s.admitChildReport(ctx, child, store.SessionInboxItem{
		SessionID: target.SessionID, InputID: uuid.NewSHA1(childReportSpace, []byte(child.ID+"\x00release\x00"+child.Input.ID)).String(),
		SenderSessionID: child.ID, Prompt: builder.String(), RequestedDelivery: store.DeliveryTurnEnd,
		InputSource: childReportSource(child, false),
	})
}

// childMessageFailed releases the child's outdated reports when the parent
// message they waited for will never start its next turn.
func (s *Server) childMessageFailed(ctx context.Context, message store.SessionInboxItem) {
	child, err := s.store.GetAgentSessionRecord(ctx, message.SessionID)
	if err != nil || child.ParentSessionID == "" {
		return
	}
	target, skip := s.childReportTarget(ctx, sessions.Slim(child))
	if skip == "" && target.SessionID != "" && followerSent(message.SenderSessionID, child, target) {
		s.releaseSupersededReports(ctx, sessions.Slim(child), target, "your message to it failed: "+message.Reason)
	}
}

// childHandedOff says why the child's own messages to the session it
// reports to (its parent, while its report waits on its item) already carry
// its turn: one repeats its answer, or its last came just before the turn
// ended.
func (s *Server) childHandedOff(ctx context.Context, child store.AgentSession, target assistant.SignalTarget) string {
	since, err := time.Parse(time.RFC3339Nano, child.Input.At)
	if err != nil {
		return ""
	}
	ended, err := time.Parse(time.RFC3339Nano, child.CompletedAt)
	if err != nil {
		ended = time.Now()
	}
	items, err := s.store.SessionInboxItems(ctx, cmp.Or(target.SessionID, child.ParentSessionID), since, 200)
	if err != nil {
		return ""
	}
	answer := strings.Join(strings.Fields(child.Response), " ")
	latest := true
	for _, item := range items {
		if item.SenderSessionID != child.ID || item.State == store.InboxFailed ||
			strings.HasPrefix(item.Prompt, sessions.ChildReportPrefix) ||
			strings.HasPrefix(item.Prompt, sessions.SessionAlertPrefix) {
			continue
		}
		if answer != "" && strings.Join(strings.Fields(item.Prompt), " ") == answer {
			return "its message " + item.InputID + " repeats its answer"
		}
		if latest && ended.Sub(item.CreatedAt) <= childReportHandoffWindow {
			return fmt.Sprintf("its message %s came %s before its turn ended", item.InputID, ended.Sub(item.CreatedAt).Round(time.Second))
		}
		latest = false
	}
	return ""
}

// childReportRead settles the report of a child's ended turn its parent
// (actor) just read another way, so it does not reach the parent again. A
// report that carries outdated ones is still delivered: reading the
// child's latest answer does not show them.
func (s *Server) childReportRead(ctx context.Context, actor Actor, session store.AgentSession) {
	if !actor.Agent() || session.ParentSessionID == "" {
		return
	}
	item, target, skip := s.childReport(ctx, session)
	if skip != "" || target.SessionID == "" || target.SessionID != actor.Identity.SessionID ||
		s.supersededChildReports(ctx, session, target.SessionID, item.InputID) != "" {
		return
	}
	// Under the placement lock: the report is not placed meanwhile.
	s.sessionService.SettleInboxItem(ctx, item, childReportReadReason)
}

// childTurnSuperseded reports whether its follower (followerSent) sent the
// child a message its ended turn did not take: the message still waits, or
// already started the child's next turn. That turn's report carries this one.
func (s *Server) childTurnSuperseded(ctx context.Context, child store.AgentSession, target assistant.SignalTarget) bool {
	started, err := time.Parse(time.RFC3339Nano, child.Input.At)
	if err != nil {
		return false
	}
	items, err := s.store.SessionInboxItems(ctx, child.ID, started.Add(-time.Hour), 200)
	if err != nil {
		return false
	}
	for _, item := range items {
		if !followerSent(item.SenderSessionID, child, target) {
			continue
		}
		if item.Pending() {
			return true
		}
		if item.DeliveredAs == "turn" && item.DeliveredInputID != child.Input.ID && item.DeliveredAt != nil && item.DeliveredAt.After(started) {
			return true
		}
	}
	return false
}

// childTookParentMessage reports whether a message from its follower
// (followerSent) reached the child's current turn.
func (s *Server) childTookParentMessage(ctx context.Context, child store.AgentSession, target assistant.SignalTarget) bool {
	started, err := time.Parse(time.RFC3339Nano, child.Input.At)
	if err != nil {
		return true
	}
	items, err := s.store.SessionInboxItems(ctx, child.ID, started.Add(-time.Hour), 200)
	if err != nil {
		return true
	}
	for _, item := range items {
		if !followerSent(item.SenderSessionID, child, target) || item.State == store.InboxFailed {
			continue
		}
		// It started the turn, or was steered into it (a steer records
		// when it arrived, not the turn).
		if item.DeliveredInputID == child.Input.ID {
			return true
		}
		taken := item.State == store.InboxDelivered || item.State == store.InboxConsumed
		if item.DeliveredAs == "steer" && taken && item.DeliveredAt != nil && !item.DeliveredAt.Before(started) {
			return true
		}
	}
	return false
}

// supersededChildReports is what the child's reports to recipientID
// outdated since its last delivered one said, for the report reportID to
// carry.
func (s *Server) supersededChildReports(ctx context.Context, child store.AgentSession, recipientID, reportID string) string {
	if recipientID == "" {
		return ""
	}
	items, err := s.store.SessionInboxItems(ctx, recipientID, time.Now().Add(-24*time.Hour), 500)
	if err != nil {
		return ""
	}
	var outdated []store.SessionInboxItem
	for _, item := range items {
		if item.SenderSessionID != child.ID || item.InputID == reportID || !strings.HasPrefix(item.Prompt, sessions.ChildReportPrefix) {
			continue
		}
		if item.Reason != childReportSupersededReason {
			break
		}
		outdated = append(outdated, item)
	}
	if len(outdated) == 0 {
		return ""
	}
	var builder strings.Builder
	if left := len(outdated) - supersededReportCount; left > 0 {
		fmt.Fprintf(&builder, "\n%d earlier turns your messages outdated are left out; read_context on %s has them.\n", left, child.ID)
		outdated = outdated[:supersededReportCount]
	}
	for index := len(outdated) - 1; index >= 0; index-- {
		item := outdated[index]
		fmt.Fprintf(&builder, "\nAn earlier turn ended %s while your newer message to it waited; it said:\n%s\n",
			item.CreatedAt.UTC().Format(time.RFC3339), textcut.Excerpt(childReportBody(item.Prompt), supersededReportLimit))
	}
	return builder.String()
}

// childReportBody is a report without its heading and link.
func childReportBody(report string) string {
	lines := strings.Split(report, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(line, sessions.ChildReportPrefix) || strings.HasPrefix(line, "Link: ") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}
