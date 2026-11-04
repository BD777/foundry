package httpapi

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf8"

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
// archived or stopped. A parent that already read the answer (get_session)
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

// childReportTarget is the parent the child reports to, or why it reports
// to none.
func (s *Server) childReportTarget(ctx context.Context, child store.AgentSession) (string, string) {
	switch {
	case child.ParentSessionID == "" || child.Input.ID == "":
		return "", "no parent"
	// Scheduled runs and Issue sessions answer to their own owners.
	case child.Source != store.SessionSourceAgent && child.Source != store.SessionSourceVerification, child.Role != "":
		return "", "not an agent's child"
	}
	if back, err := s.store.ChildReportBack(ctx, child.ID); err == nil && !back {
		return "", "reportBack is off"
	}
	parent, err := s.store.GetAgentSessionSummary(ctx, child.ParentSessionID)
	switch {
	case err != nil:
		return "", "the parent is gone"
	case parent.ArchivedAt != "":
		return "", "the parent is archived"
	case parent.Status == "canceled":
		return "", "the parent was stopped"
	case parent.Role != "":
		return "", "the parent is controlled by its Issue"
	}
	// The person's assistant follows the work it hands out itself.
	if _, _, ok := s.assistant.TaskOf(ctx, child); ok {
		return "", "an assistant task"
	}
	return parent.ID, ""
}

// childReport is the report of the child's turn (child as it ended) for
// its parent, or why the turn has none. parentID is set whenever the child
// reports to a parent at all.
func (s *Server) childReport(ctx context.Context, child store.AgentSession) (item store.SessionInboxItem, parentID, skip string) {
	if parentID, skip = s.childReportTarget(ctx, child); skip != "" {
		return item, "", skip
	}
	if child.Status != "completed" && child.Status != "failed" {
		return item, parentID, "status " + child.Status
	}
	// A turn its own schedule or wake-up started reports nothing the
	// parent asked for, unless the parent's message reached it meanwhile.
	if child.Input.TimerFire != nil && !s.childTookParentMessage(ctx, child) {
		return item, parentID, "a timer started the turn"
	}
	return store.SessionInboxItem{
		SessionID: parentID, InputID: childReportInputID(child), SenderSessionID: child.ID,
		Prompt: s.childReportText(child), RequestedDelivery: store.DeliveryTurnEnd,
	}, parentID, ""
}

// childReportText is a compact handoff of the child's turn.
func (s *Server) childReportText(child store.AgentSession) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "%s session %s (%q), which this session created, finished a turn: %s.\n", sessions.ChildReportPrefix, child.ID, child.Title, child.Status)
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

// reportChildTurn puts the report of the child's ended turn in its
// parent's inbox, unless there is none or the child handed off itself. A
// turn whose carrier of outdated reports this was, and that reports
// nothing, releases them on their own.
func (s *Server) reportChildTurn(ctx context.Context, child store.AgentSession) {
	item, parentID, skip := s.childReport(ctx, child)
	if skip == "" {
		skip = s.childHandedOff(ctx, child)
	}
	if skip != "" {
		log.Printf("session child report skipped: session=%s child=%s input=%s reason=%q", child.ParentSessionID, child.ID, child.Input.ID, skip)
		if parentID != "" {
			s.releaseSupersededReports(ctx, child, parentID, "the turn after them did not report: "+skip)
		}
		return
	}
	if s.childTurnSuperseded(ctx, child) {
		log.Printf("session child report superseded: session=%s child=%s input=%s", child.ParentSessionID, child.ID, child.Input.ID)
		s.sessionService.SettleInboxItem(ctx, item, childReportSupersededReason)
		return
	}
	item.Prompt += s.supersededChildReports(ctx, child, item.InputID)
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
// parent's messages outdated, once what was to carry them will not: why
// says what happened instead. Nothing is sent when none is outstanding.
func (s *Server) releaseSupersededReports(ctx context.Context, child store.AgentSession, parentID, why string) {
	carried := s.supersededChildReports(ctx, child, "")
	if carried == "" {
		return
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "%s session %s (%q), which this session created, has turns your newer messages outdated that no later report carried (%s).\n",
		sessions.ChildReportPrefix, child.ID, child.Title, why)
	if link := s.assistant.SessionURL(child); link != "" {
		fmt.Fprintf(&builder, "Link: %s\n", link)
	}
	builder.WriteString(carried)
	log.Printf("session child report released: session=%s child=%s input=%s why=%q", parentID, child.ID, child.Input.ID, why)
	s.admitChildReport(ctx, child, store.SessionInboxItem{
		SessionID: parentID, InputID: uuid.NewSHA1(childReportSpace, []byte(child.ID+"\x00release\x00"+child.Input.ID)).String(),
		SenderSessionID: child.ID, Prompt: builder.String(), RequestedDelivery: store.DeliveryTurnEnd,
	})
}

// childMessageFailed releases the child's outdated reports when the parent
// message they waited for will never start its next turn.
func (s *Server) childMessageFailed(ctx context.Context, message store.SessionInboxItem) {
	child, err := s.store.GetAgentSessionRecord(ctx, message.SessionID)
	if err != nil || child.ParentSessionID == "" || child.ParentSessionID != message.SenderSessionID {
		return
	}
	if parentID, skip := s.childReportTarget(ctx, sessions.Slim(child)); skip == "" {
		s.releaseSupersededReports(ctx, sessions.Slim(child), parentID, "your message to it failed: "+message.Reason)
	}
}

// childHandedOff says why the child's own messages to its parent already
// carry its turn: one repeats its answer, or its last came just before the
// turn ended.
func (s *Server) childHandedOff(ctx context.Context, child store.AgentSession) string {
	since, err := time.Parse(time.RFC3339Nano, child.Input.At)
	if err != nil {
		return ""
	}
	ended, err := time.Parse(time.RFC3339Nano, child.CompletedAt)
	if err != nil {
		ended = time.Now()
	}
	items, err := s.store.SessionInboxItems(ctx, child.ParentSessionID, since, 200)
	if err != nil {
		return ""
	}
	answer := strings.Join(strings.Fields(child.Response), " ")
	latest := true
	for _, item := range items {
		if item.SenderSessionID != child.ID || item.State == store.InboxFailed || strings.HasPrefix(item.Prompt, sessions.ChildReportPrefix) {
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
	if !actor.Agent() || session.ParentSessionID == "" || session.ParentSessionID != actor.Identity.SessionID {
		return
	}
	item, _, skip := s.childReport(ctx, session)
	if skip != "" || s.supersededChildReports(ctx, session, item.InputID) != "" {
		return
	}
	// Under the placement lock: the report is not placed meanwhile.
	s.sessionService.SettleInboxItem(ctx, item, childReportReadReason)
}

// childTurnSuperseded reports whether the parent sent the child a message
// its ended turn did not take: the message still waits, or already started
// the child's next turn. That turn's report carries this one.
func (s *Server) childTurnSuperseded(ctx context.Context, child store.AgentSession) bool {
	started, err := time.Parse(time.RFC3339Nano, child.Input.At)
	if err != nil {
		return false
	}
	items, err := s.store.SessionInboxItems(ctx, child.ID, started.Add(-time.Hour), 200)
	if err != nil {
		return false
	}
	for _, item := range items {
		if item.SenderSessionID != child.ParentSessionID {
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

// childTookParentMessage reports whether a message from the parent reached
// the child's current turn.
func (s *Server) childTookParentMessage(ctx context.Context, child store.AgentSession) bool {
	started, err := time.Parse(time.RFC3339Nano, child.Input.At)
	if err != nil {
		return true
	}
	items, err := s.store.SessionInboxItems(ctx, child.ID, started.Add(-time.Hour), 200)
	if err != nil {
		return true
	}
	for _, item := range items {
		if item.SenderSessionID != child.ParentSessionID || item.State == store.InboxFailed {
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

// supersededChildReports is what the child's reports outdated since its
// last delivered one said, for the report reportID to carry.
func (s *Server) supersededChildReports(ctx context.Context, child store.AgentSession, reportID string) string {
	items, err := s.store.SessionInboxItems(ctx, child.ParentSessionID, time.Now().Add(-24*time.Hour), 500)
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
