package assistant

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Upkeep is Foundry's scheduled maintenance of the person's projects
// (reviews, summaries and memory sorting). This file keeps the facts of
// that upkeep in the assistant's own folder, .foundry/upkeep.md, where the
// assistant reads them when they matter (DEV-252).
//
// Foundry never turns an upkeep state change into a turn of the person's
// conversation: a push into the assistant's conversation is a turn that
// steers its attention, so upkeep is made available as facts instead. The
// file is excluded from the runtime's instruction revision (the Worker's
// foundryFactFile), so refreshing it never restarts the native conversation.
//
// Only the assistant the upkeep belongs to gets the facts: a job is its
// AssistantID's (a global governance review is the default assistant's, a
// memory review is its layer's owner's), and due summaries are the default
// assistant's, since they run on its home.

// upkeepProposal is a review whose suggested changes wait for the person.
type upkeepProposal struct {
	WorkspaceID string
	Project     string
	Changes     int
	Since       time.Time
}

// upkeepJob is a failed or stalled review.
type upkeepJob struct {
	WorkspaceID string
	Project     string
	Role        string
	Reason      string
	Since       time.Time
}

// upkeepDigest is a summary that is due and waits for its home computer.
type upkeepDigest struct {
	WorkspaceID string
	Project     string
	DueAt       time.Time
}

// upkeepState is what one assistant's upkeep needs it to know now.
type upkeepState struct {
	Signature   string
	Proposals   []upkeepProposal
	Failed      []upkeepJob
	Stalled     []upkeepJob
	Digests     []upkeepDigest
	DeviceLabel string
}

// RefreshUpkeep writes each assistant's upkeep facts into its home folder
// when they changed. It replaces the state-change notices of DEV-238: no
// input is sent to any conversation.
func (s *Service) RefreshUpkeep(ctx context.Context) {
	now := time.Now()
	if now.Sub(s.lastUpkeepNotice) < UpkeepSweepInterval {
		return
	}
	s.lastUpkeepNotice = now
	agents, err := s.store.ListPersonalAgents(ctx)
	if err != nil {
		return
	}
	jobsByUser := map[string][]store.PersonalAgentMaintenance{}
	for _, agent := range agents {
		if agent.State != store.PersonalAgentActive {
			continue
		}
		if user, err := s.store.GetUser(ctx, agent.UserID); err != nil || !user.Active() {
			continue
		}
		jobs, ok := jobsByUser[agent.UserID]
		if !ok {
			jobs, err = s.store.ListPersonalAgentMaintenanceForUser(ctx, agent.UserID)
			if err != nil {
				continue
			}
			jobsByUser[agent.UserID] = jobs
		}
		state := s.upkeepStateOf(ctx, agent, jobs, now)
		last, err := s.store.UpkeepNoticeSignature(ctx, agent.ID)
		if err != nil || last == state.Signature {
			continue
		}
		content := upkeepFileContent(state, now, s.PersonLocation(ctx, agent), s.WebURL(personalagent.AssistantSettingsPath(agent.ID)))
		wrote, err := s.writeUpkeepFile(ctx, agent, content)
		if err != nil {
			log.Printf("assistant %s: write upkeep facts: %v", agent.ID, err)
			continue
		}
		if !wrote {
			// The home is offline; the run that brings it back writes the
			// file, so the signature stays to be recorded then.
			continue
		}
		_ = s.store.SaveUpkeepNoticeSignature(ctx, agent.ID, state.Signature, formatPATime(now))
	}
}

// upkeepStateOf reads one assistant's jobs and returns the facts it should
// see. Repeatedly deferred jobs keep the same signature, and a due summary
// is counted only when it is due now and blocked on the home computer.
func (s *Service) upkeepStateOf(ctx context.Context, agent store.PersonalAgent, jobs []store.PersonalAgentMaintenance, now time.Time) upkeepState {
	state := upkeepState{}
	names := map[string]string{}
	project := func(workspaceID string) string {
		if name, ok := names[workspaceID]; ok {
			return name
		}
		name := workspaceID
		if workspace, err := s.store.GetWorkspace(ctx, workspaceID); err == nil && workspace.Name != "" {
			name = workspace.Name
		}
		names[workspaceID] = name
		return name
	}
	parts := []string{}
	for _, job := range jobs {
		if job.AssistantID != agent.ID {
			continue
		}
		switch job.Status {
		case "review":
			if job.Result != nil && len(job.Result.Patches) > 0 {
				state.Proposals = append(state.Proposals, upkeepProposal{
					WorkspaceID: job.WorkspaceID, Project: project(job.WorkspaceID),
					Changes: len(job.Result.Patches), Since: upkeepTime(job.UpdatedAt),
				})
				parts = append(parts, fmt.Sprintf("review:%s:%d", job.ID, len(job.Result.Patches)))
			}
		case "failed":
			state.Failed = append(state.Failed, upkeepJob{
				WorkspaceID: job.WorkspaceID, Project: project(job.WorkspaceID),
				Role: job.Role, Reason: job.Reason, Since: upkeepTime(job.UpdatedAt),
			})
			parts = append(parts, "failed:"+job.ID)
		case "waiting", "starting", "running":
			since := upkeepTime(job.WaitingSince)
			if since.IsZero() || now.Sub(since) < upkeepStallAfter {
				continue
			}
			state.Stalled = append(state.Stalled, upkeepJob{
				WorkspaceID: job.WorkspaceID, Project: project(job.WorkspaceID),
				Role: job.Role, Reason: job.Reason, Since: since,
			})
			parts = append(parts, "stalled:"+job.ID+":"+job.Status+":"+job.Reason)
		}
	}
	if agent.IsDefault && !s.devices.Connected(agent.HomeDeviceID) {
		if records, err := s.store.ListWorkspaceDigests(ctx, agent.UserID); err == nil {
			state.Digests = dueDigestFacts(records, now)
		}
		if len(state.Digests) > 0 {
			state.DeviceLabel = s.deviceLabel(ctx, agent.HomeDeviceID)
		}
		for _, digest := range state.Digests {
			parts = append(parts, "digest:"+digest.WorkspaceID)
		}
	}
	slices.Sort(parts)
	state.Signature = fmt.Sprintf("%x", sha256.Sum256([]byte(strings.Join(parts, "|"))))
	return state
}

// dueDigestFacts are the distinct workspaces whose summary is due by now
// and not running, most overdue first.
func dueDigestFacts(records []store.WorkspaceDigestRecord, now time.Time) []upkeepDigest {
	seen := map[string]bool{}
	out := []upkeepDigest{}
	for _, record := range records {
		workspaceID := record.Digest.WorkspaceID
		if record.SummaryDueAt == "" || record.SummarySessionID != "" || seen[workspaceID] {
			continue
		}
		due := upkeepTime(record.SummaryDueAt)
		if due.IsZero() || due.After(now) {
			continue
		}
		seen[workspaceID] = true
		name := record.Digest.Name
		if name == "" {
			name = workspaceID
		}
		out = append(out, upkeepDigest{WorkspaceID: workspaceID, Project: name, DueAt: due})
	}
	slices.SortFunc(out, func(a, b upkeepDigest) int {
		if cmp := a.DueAt.Compare(b.DueAt); cmp != 0 {
			return cmp
		}
		return strings.Compare(a.Project, b.Project)
	})
	return out
}

// upkeepFileContent is the facts file's text: what waits for the person,
// what failed or stalled, and summaries due on an offline home. It says so
// plainly when there is nothing.
func upkeepFileContent(state upkeepState, now time.Time, location *time.Location, settingsURL string) string {
	var out strings.Builder
	out.WriteString("# Upkeep\n\n")
	if location == nil {
		location = time.UTC
	}
	fmt.Fprintf(&out, "As of %s (%s).\n", now.In(location).Format("2006-01-02 15:04"), location.String())
	if len(state.Proposals) == 0 && len(state.Failed) == 0 && len(state.Stalled) == 0 && len(state.Digests) == 0 {
		out.WriteString("\nNothing needs attention.\n")
		return out.String()
	}
	when := func(at time.Time) string {
		if at.IsZero() {
			return ""
		}
		return at.In(location).Format("2006-01-02 15:04")
	}
	if len(state.Proposals) > 0 {
		out.WriteString("\n## Changes waiting for the person\n\n")
		for _, proposal := range state.Proposals {
			fmt.Fprintf(&out, "- %s (%s): %d suggested changes", proposal.Project, proposal.WorkspaceID, proposal.Changes)
			if at := when(proposal.Since); at != "" {
				fmt.Fprintf(&out, ", since %s", at)
			}
			out.WriteString(".")
			if settingsURL != "" {
				fmt.Fprintf(&out, " Settings: %s", settingsURL)
			}
			out.WriteString("\n")
		}
	}
	if len(state.Failed) > 0 {
		out.WriteString("\n## Failed reviews\n\n")
		for _, job := range state.Failed {
			fmt.Fprintf(&out, "- %s (%s): %s review failed", job.Project, job.WorkspaceID, upkeepRole(job.Role))
			if job.Reason != "" {
				fmt.Fprintf(&out, " (%s)", job.Reason)
			}
			if at := when(job.Since); at != "" {
				fmt.Fprintf(&out, " at %s", at)
			}
			out.WriteString(".\n")
		}
	}
	if len(state.Stalled) > 0 {
		out.WriteString("\n## Reviews waiting too long\n\n")
		for _, job := range state.Stalled {
			fmt.Fprintf(&out, "- %s (%s): %s review waiting", job.Project, job.WorkspaceID, upkeepRole(job.Role))
			if at := when(job.Since); at != "" {
				fmt.Fprintf(&out, " since %s", at)
			}
			if job.Reason != "" {
				fmt.Fprintf(&out, " (%s)", job.Reason)
			}
			out.WriteString(".\n")
		}
	}
	if len(state.Digests) > 0 {
		out.WriteString("\n## Summaries due\n\n")
		noun := "summaries are"
		if len(state.Digests) == 1 {
			noun = "summary is"
		}
		fmt.Fprintf(&out, "%d %s due and wait for %s to come online.\n", len(state.Digests), noun, state.DeviceLabel)
		for _, digest := range state.Digests {
			fmt.Fprintf(&out, "- %s (%s)", digest.Project, digest.WorkspaceID)
			if at := when(digest.DueAt); at != "" {
				fmt.Fprintf(&out, ", due since %s", at)
			}
			out.WriteString("\n")
		}
	}
	return out.String()
}

// upkeepFileFor is the facts file as a run of the assistant's home gets it.
func (s *Service) upkeepFileFor(ctx context.Context, agent store.PersonalAgent, now time.Time) string {
	jobs, err := s.store.ListPersonalAgentMaintenanceForUser(ctx, agent.UserID)
	if err != nil {
		return ""
	}
	state := s.upkeepStateOf(ctx, agent, jobs, now)
	return upkeepFileContent(state, now, s.PersonLocation(ctx, agent), s.WebURL(personalagent.AssistantSettingsPath(agent.ID)))
}

// writeUpkeepFile writes the facts into the assistant's home, if it is
// online. It reports whether the file was written.
func (s *Service) writeUpkeepFile(ctx context.Context, agent store.PersonalAgent, content string) (bool, error) {
	workspace, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil {
		return false, err
	}
	if workspace.DeviceID == "" || !s.devices.Connected(workspace.DeviceID) {
		return false, nil
	}
	if err := s.devices.WriteWorkspaceFile(ctx, workspace, prompt.UpkeepPath, content); err != nil {
		return false, err
	}
	return true, nil
}

func upkeepTime(raw string) time.Time {
	at, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}
	}
	return at
}

func upkeepRole(role string) string {
	if role == "memory" {
		return "memory"
	}
	return "project"
}

func (s *Service) deviceLabel(ctx context.Context, deviceID string) string {
	if label := s.devices.Label(ctx, deviceID); label != "" {
		return label
	}
	return deviceID
}
