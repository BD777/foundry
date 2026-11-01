package httpapi

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
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
// gather briefly, so children that end together start one parent turn.

const (
	// childReportPrefix opens every report.
	childReportPrefix = "Foundry report:"
	// childReportAnswerLimit is how much of the answer a report carries.
	childReportAnswerLimit = 1500
	// childReportReadReason settles a report its parent read elsewhere.
	childReportReadReason = "read_by_parent"
)

var (
	// childReportHandoffWindow: a message the child sent its parent this
	// close to its turn's end is that turn's handoff. Measured on dev
	// (2026-10-28/29): 47 of 75 child-to-parent messages came 5-24 s before
	// the turn ended with no work after them; every other came 82 s or more
	// before, with tools run since.
	childReportHandoffWindow = 45 * time.Second
	// childReportGather: a report to a parent between turns waits this long
	// for its siblings, so children that end together start one parent turn.
	childReportGather = 10 * time.Second
	// childReportSpace names the ids of reports.
	childReportSpace = uuid.MustParse("6f1f5d0e-7a52-4c39-9a4e-0d9b5a1c2e90")
)

// childReportInputID is the id of the report of the child's latest input.
func childReportInputID(child store.AgentSession) string {
	return uuid.NewSHA1(childReportSpace, []byte(child.ID+"\x00"+child.Input.ID)).String()
}

// childReportReactions reports a child's ended turn to its parent.
type childReportReactions struct{ s *Server }

func (r childReportReactions) sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession) {
	if change != sessionCompleted || session.ParentSessionID == "" {
		return
	}
	r.s.reportChildTurn(ctx, session.ID)
}

// childReport is the report of the child's latest turn for its parent, or
// why it has none.
func (s *Server) childReport(ctx context.Context, childID string) (store.AgentSession, store.SessionInboxItem, string) {
	var none store.SessionInboxItem
	child, err := s.store.GetAgentSessionRecord(ctx, childID)
	if err != nil {
		return child, none, "the child cannot be read"
	}
	switch {
	case child.ParentSessionID == "" || child.Input.ID == "":
		return child, none, "no parent"
	case child.Status != "completed" && child.Status != "failed":
		return child, none, "status " + child.Status
	// Scheduled runs and Issue sessions answer to their own owners.
	case child.Source != "agent" && child.Source != verificationSource, child.Role != "":
		return child, none, "not an agent's child"
	}
	if back, err := s.store.ChildReportBack(ctx, child.ID); err == nil && !back {
		return child, none, "reportBack is off"
	}
	parent, err := s.store.GetAgentSessionSummary(ctx, child.ParentSessionID)
	switch {
	case err != nil:
		return child, none, "the parent is gone"
	case parent.ArchivedAt != "":
		return child, none, "the parent is archived"
	case parent.Status == "canceled":
		return child, none, "the parent was stopped"
	case parent.Role != "":
		return child, none, "the parent is controlled by its Issue"
	}
	// The person's assistant follows the work it hands out itself.
	if _, _, ok := s.assistantTaskOf(ctx, child); ok {
		return child, none, "an assistant task"
	}
	return child, store.SessionInboxItem{
		SessionID: parent.ID, InputID: childReportInputID(child), SenderSessionID: child.ID,
		Prompt: s.childReportText(child), RequestedDelivery: store.DeliveryTurnEnd,
	}, ""
}

// childReportText is a compact handoff of the child's turn.
func (s *Server) childReportText(child store.AgentSession) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "%s session %s (%q), which this session created, finished a turn: %s.\n", childReportPrefix, child.ID, child.Title, child.Status)
	if link := s.sessionURL(child); link != "" {
		fmt.Fprintf(&builder, "Link: %s\n", link)
	}
	if failure := strings.TrimSpace(child.Error); failure != "" {
		fmt.Fprintf(&builder, "Error: %s\n", excerpt(failure, 300))
	}
	answer := strings.TrimSpace(child.Response)
	switch length := utf8.RuneCountInString(answer); {
	case length == 0:
		builder.WriteString("It gave no final answer.\n")
	case length <= childReportAnswerLimit:
		fmt.Fprintf(&builder, "\nFinal answer:\n%s\n", answer)
	default:
		fmt.Fprintf(&builder, "\nFinal answer (first %d of %d characters; get_session or read_context on %s has the rest):\n%s\n",
			childReportAnswerLimit, length, child.ID, excerpt(answer, childReportAnswerLimit))
	}
	return builder.String()
}

// reportChildTurn puts the report of the child's ended turn in its
// parent's inbox, unless there is none or the child handed off itself.
func (s *Server) reportChildTurn(ctx context.Context, childID string) {
	child, item, skip := s.childReport(ctx, childID)
	if skip == "" {
		skip = s.childHandedOff(ctx, child)
	}
	if skip != "" {
		if child.ParentSessionID != "" {
			log.Printf("session child report skipped: session=%s child=%s input=%s reason=%q", child.ParentSessionID, child.ID, child.Input.ID, skip)
		}
		return
	}
	admission, err := s.store.AdmitSessionInboxItem(ctx, item, store.SessionInboxRules{Now: time.Now().UTC(), DedupWindow: inboxDedupWindow})
	if err != nil {
		log.Printf("report session %s to %s: %v", child.ID, item.SessionID, err)
		return
	}
	if !admission.Duplicate {
		logInboxItem("admitted", admission.Item)
		s.inbox.wake()
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
		if item.SenderSessionID != child.ID || item.State == store.InboxFailed || strings.HasPrefix(item.Prompt, childReportPrefix) {
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
// (actor) just read another way, so it does not reach the parent again.
func (s *Server) childReportRead(ctx context.Context, actor Actor, session store.AgentSession) {
	if !actor.Agent() || session.ParentSessionID == "" || session.ParentSessionID != actor.Identity.SessionID {
		return
	}
	if session.Status != "completed" && session.Status != "failed" {
		return
	}
	_, item, skip := s.childReport(ctx, session.ID)
	if skip != "" {
		return
	}
	// Under the placement lock: the report is not placed meanwhile.
	s.inbox.mu.Lock()
	defer s.inbox.mu.Unlock()
	admission, err := s.store.AdmitSessionInboxItem(ctx, item, store.SessionInboxRules{Now: time.Now().UTC()})
	if err != nil || admission.Item.InputID != item.InputID {
		return
	}
	s.changeInboxItem(ctx, admission.Item, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxConsumed, Reason: childReportReadReason})
}

// childReportsGathering reports whether the due messages of a session
// between turns wait for more reports: one of them is a report younger than
// childReportGather.
func childReportsGathering(items []store.SessionInboxItem, due []int, now time.Time) bool {
	for _, index := range due {
		item := items[index]
		if strings.HasPrefix(item.Prompt, childReportPrefix) && now.Sub(item.CreatedAt) < childReportGather {
			return true
		}
	}
	return false
}

// recentMessages is what a sender sent one recipient in the last hour.
type recentMessages struct {
	LastHour int `json:"lastHour"`
	// BoundaryOrInterrupt of them reached, or reach, a running turn.
	BoundaryOrInterrupt int `json:"boundaryOrInterrupt"`
}

// recentToRecipient counts the sender's messages to the session in the
// last hour, this one included; Foundry's reports are not the sender's.
func (s *Server) recentToRecipient(ctx context.Context, sessionID, senderSessionID string) *recentMessages {
	items, err := s.store.SessionInboxItems(ctx, sessionID, time.Now().Add(-time.Hour), 500)
	if err != nil {
		return nil
	}
	recent := &recentMessages{}
	for _, item := range items {
		if item.SenderSessionID != senderSessionID || strings.HasPrefix(item.Prompt, childReportPrefix) {
			continue
		}
		recent.LastHour++
		if item.Delivery == store.DeliveryBoundary || item.Delivery == store.DeliveryInterrupt {
			recent.BoundaryOrInterrupt++
		}
	}
	return recent
}
