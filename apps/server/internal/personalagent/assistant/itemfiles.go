package assistant

import (
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Item files (DEV-324 §4): every item whose home is a workspace is written,
// read-only, into that workspace's .foundry/items/<id>.md through the same
// device file channel as the assistant's project files, so an agent working
// there reads the item from its folder instead of calling a tool. Only the
// items of the device's owner are written: a session reads only its own
// person's items, and another person's item homed there gets no file (one
// written before is removed). Foundry never reads the files back: the next
// write replaces them.

const (
	// ItemFilesDir is where a workspace's item files live.
	ItemFilesDir = ".foundry/items"
	// ItemFileNotice is the line every item file starts its front matter with.
	ItemFileNotice = "# 由 Foundry 生成，只读，改动会被覆盖；改事项用 update_list（op claim 接手并替换当前 holder，op decide 记本人的决定）"
	// itemFileTimeline is how many of the latest events an item file shows.
	itemFileTimeline = 20
	// itemFileDelay gathers a burst of changes into one write per workspace.
	itemFileDelay = 2 * time.Second
	// itemFileWriteTimeout bounds one workspace's write.
	itemFileWriteTimeout = 2 * time.Minute
)

var itemFileID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// itemFileProjector gathers item changes per workspace and writes them after
// itemFileDelay; it remembers what it last wrote so a reconnect writes only
// what changed or went missing.
type itemFileProjector struct {
	mu      sync.Mutex
	delay   time.Duration
	pending map[string]map[string]bool
	written map[string][32]byte
	writes  keyedMutex
}

// ItemChanged schedules the item's file in each workspace the change concerns.
// The store calls it inside the change's transaction, so it only takes note.
func (s *Service) ItemChanged(change store.PersonalAgentItemChange) {
	p := &s.itemFiles
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pending == nil {
		p.pending = map[string]map[string]bool{}
	}
	delay := p.delay
	if delay == 0 {
		delay = itemFileDelay
	}
	for _, workspaceID := range change.Workspaces {
		items, scheduled := p.pending[workspaceID]
		if !scheduled {
			items = map[string]bool{}
			p.pending[workspaceID] = items
			time.AfterFunc(delay, func() { s.flushItemFiles(workspaceID) })
		}
		items[change.ItemID] = true
	}
}

// flushItemFiles writes or removes the files of the items that changed in
// the workspace since the last flush.
func (s *Service) flushItemFiles(workspaceID string) {
	p := &s.itemFiles
	p.mu.Lock()
	changed := p.pending[workspaceID]
	delete(p.pending, workspaceID)
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), itemFileWriteTimeout)
	defer cancel()
	if err := s.writeItemFiles(ctx, workspaceID, changed); err != nil {
		log.Printf("item files of %s: %v", workspaceID, err)
	}
}

// ProjectDeviceItemFiles brings the item files of every workspace on a device
// that just connected up to date: what changed while it was away is written,
// files of items no longer at home there are removed.
func (s *Service) ProjectDeviceItemFiles(ctx context.Context, deviceID string) {
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		log.Printf("item files of device %s: %v", deviceID, err)
		return
	}
	for _, workspace := range workspaces {
		if workspace.DeviceID != deviceID || workspace.ArchivedAt != "" {
			continue
		}
		if err := s.writeItemFiles(ctx, workspace.ID, nil); err != nil {
			log.Printf("item files of %s: %v", workspace.ID, err)
		}
	}
}

// ProjectItemFiles writes every item file of the workspace now and removes
// the stale ones.
func (s *Service) ProjectItemFiles(ctx context.Context, workspaceID string) error {
	return s.writeItemFiles(ctx, workspaceID, nil)
}

// writeItemFiles writes the files of the changed items (nil: all of them,
// pruning the files of items no longer at home) into a workspace whose
// device is connected. An offline device is brought up to date when it
// connects.
func (s *Service) writeItemFiles(ctx context.Context, workspaceID string, changed map[string]bool) error {
	p := &s.itemFiles
	p.writes.Lock(workspaceID)
	defer p.writes.Unlock(workspaceID)
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil || workspace.ArchivedAt != "" || workspace.DeviceID == "" || !s.devices.Connected(workspace.DeviceID) {
		return nil
	}
	owner, err := s.store.DeviceOwner(ctx, workspace.DeviceID)
	if err != nil {
		return err
	}
	items, helpers, err := s.store.ListPersonalAgentItemsAtHome(ctx, owner, workspaceID)
	if err != nil {
		return err
	}
	if changed == nil && len(items) == 0 {
		// A workspace no item ever had as its home has no files to prune:
		// a full pass asks its device nothing.
		homed, err := s.store.PersonalAgentItemsWereHomedIn(ctx, workspaceID)
		if err != nil || !homed {
			return err
		}
	}
	existing := map[string]bool{}
	entries, err := s.devices.ListWorkspaceTree(ctx, workspace, ItemFilesDir)
	if err == nil {
		for _, entry := range entries {
			if !entry.IsDirectory {
				existing[entry.Name] = true
			}
		}
	}
	listed := err == nil
	home := map[string]bool{}
	locations := map[string]*time.Location{}
	var firstErr error
	for _, item := range items {
		if !itemFileID.MatchString(item.ID) {
			continue
		}
		home[item.ID] = true
		if changed != nil && !changed[item.ID] {
			continue
		}
		events, err := s.store.ListPersonalAgentItemEvents(ctx, item.AssistantID, item.ID)
		if err != nil {
			return err
		}
		location, ok := locations[item.AssistantID]
		if !ok {
			agent, err := s.store.GetAssistant(ctx, item.AssistantID)
			if err != nil {
				return err
			}
			location = s.PersonLocation(ctx, agent)
			locations[item.AssistantID] = location
		}
		content := ItemFile(item, helpers[item.ID], events, location)
		name := item.ID + ".md"
		key := workspaceID + "/" + item.ID
		sum := sha256.Sum256([]byte(content))
		p.mu.Lock()
		same := p.written[key] == sum
		p.mu.Unlock()
		if same && listed && existing[name] {
			continue
		}
		if err := s.devices.WriteWorkspaceFile(ctx, workspace, ItemFilesDir+"/"+name, content); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("write %s: %w", name, err)
			}
			continue
		}
		p.mu.Lock()
		if p.written == nil {
			p.written = map[string][32]byte{}
		}
		p.written[key] = sum
		p.mu.Unlock()
	}
	for name := range existing {
		id, ok := strings.CutSuffix(name, ".md")
		if !ok || home[id] || (changed != nil && !changed[id]) {
			continue
		}
		if err := s.devices.DeleteWorkspaceFile(ctx, workspace, ItemFilesDir+"/"+name); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("remove %s: %w", name, err)
			}
			continue
		}
		p.mu.Lock()
		delete(p.written, workspaceID+"/"+id)
		p.mu.Unlock()
	}
	return firstErr
}

// ItemFile is an item as its home's agents read it: front matter with its
// facts, then its goal, progress, evidence, helpers and latest events. The
// front matter keeps RFC 3339; the times people read are in location.
func ItemFile(item store.PersonalAgentListItem, helpers []store.PersonalAgentTask, events []store.PersonalAgentItemEvent, location *time.Location) string {
	var out strings.Builder
	out.WriteString("---\n")
	out.WriteString(ItemFileNotice + "\n")
	field := func(key string, value any) {
		fmt.Fprintf(&out, "%s: %s\n", key, yamlValue(value))
	}
	touches := store.ItemTouches(item.HomeWorkspaceID, helpers)
	if touches == nil {
		touches = []string{}
	}
	field("id", item.ID)
	field("title", itemFileLine(item.Text))
	field("status", item.Status)
	field("owner", item.Owner)
	field("home", item.HomeWorkspaceID)
	field("touches", touches)
	field("holder", item.HolderSessionID)
	field("updated", item.UpdatedAt)
	field("revision", item.Revision)
	out.WriteString("---\n\n")
	fmt.Fprintf(&out, "# %s\n", itemFileLine(item.Text))

	section := func(title string) { fmt.Fprintf(&out, "\n## %s\n\n", title) }
	none := func() { out.WriteString("（暂无）\n") }

	section("目标")
	words := strings.TrimSpace(item.Quote)
	if words == "" {
		words = strings.TrimSpace(item.Text)
	}
	out.WriteString("本人原话：\n\n")
	for _, line := range strings.Split(words, "\n") {
		out.WriteString(strings.TrimRight("> "+line, " ") + "\n")
	}
	if summary := strings.TrimSpace(item.Summary); summary != "" {
		out.WriteString("\n摘要：\n\n" + summary + "\n")
	}

	section("决定")
	decisions := itemDecisions(events, location)
	for _, decision := range decisions {
		out.WriteString(decision + "\n")
	}
	if len(decisions) == 0 {
		none()
	}

	plan := item.Plan
	if plan == nil {
		plan = &store.PersonalAgentItemPlan{}
	}
	section("完成标准")
	for _, criterion := range plan.Acceptance {
		out.WriteString("- " + itemFileLine(criterion) + "\n")
	}
	if len(plan.Acceptance) == 0 {
		none()
	}

	section("进展")
	progress := 0
	for _, entry := range [][2]string{{"进展", plan.Progress}, {"下一步", plan.NextAction}, {"等待", plan.WaitingFor}} {
		if value := strings.TrimSpace(entry[1]); value != "" {
			fmt.Fprintf(&out, "- %s：%s\n", entry[0], itemFileLine(value))
			progress++
		}
	}
	if progress == 0 {
		none()
	}

	section("证据")
	for _, evidence := range plan.Evidence {
		line := "- "
		if evidence.Kind != "" {
			line += "[" + evidence.Kind + "] "
		}
		line += itemFileLine(evidence.Summary)
		if evidence.Ref != "" {
			line += " (" + itemFileLine(evidence.Ref) + ")"
		}
		if evidence.ObservedAt != "" {
			line += "，" + zonedTime(evidence.ObservedAt, location)
		}
		out.WriteString(strings.TrimRight(line, " ") + "\n")
	}
	if len(plan.Evidence) == 0 {
		none()
	}

	section("帮手")
	for _, helper := range helpers {
		line := "- " + helper.SessionID
		if title := itemFileLine(helper.Title); title != "" {
			line += " — " + title
		}
		if helper.Status != "" {
			line += " — " + helper.Status
		}
		if helper.WorkspaceID != "" && helper.WorkspaceID != item.HomeWorkspaceID {
			line += "（" + helper.WorkspaceID + "）"
		}
		out.WriteString(line + "\n")
	}
	if len(helpers) == 0 {
		none()
	}

	section("最近时间线")
	if len(events) > itemFileTimeline {
		events = events[len(events)-itemFileTimeline:]
	}
	for i := len(events) - 1; i >= 0; i-- {
		out.WriteString(itemEventLine(events[i], location) + "\n")
	}
	if len(events) == 0 {
		none()
	}
	return out.String()
}

// itemDecisions are the item's decided events, oldest first, each with its id
// (what a later decision supersedes), the person's words, and whether a later
// one replaced it.
func itemDecisions(events []store.PersonalAgentItemEvent, location *time.Location) []string {
	replacedBy := map[string]string{}
	for _, event := range events {
		if event.Kind == store.PersonalAgentItemEventDecided && event.Detail != nil && event.Detail.Supersedes != "" {
			replacedBy[event.Detail.Supersedes] = event.ID
		}
	}
	var lines []string
	for _, event := range events {
		if event.Kind != store.PersonalAgentItemEventDecided || event.Detail == nil {
			continue
		}
		line := "- " + zonedTime(event.At, location) + " · `" + event.ID + "` · " + itemFileLine(event.Detail.Decision)
		if by := replacedBy[event.ID]; by != "" {
			line = "- ~~" + strings.TrimPrefix(line, "- ") + "~~（已被 `" + by + "` 取代）"
		}
		lines = append(lines, line, "  > "+itemFileLine(event.Detail.Quote))
	}
	return lines
}

// itemEventLine is one timeline event: when, who, what, and its detail.
func itemEventLine(event store.PersonalAgentItemEvent, location *time.Location) string {
	line := "- " + zonedTime(event.At, location) + " · " + event.Actor + " · " + event.Kind
	detail := event.Detail
	if detail == nil {
		return line
	}
	var parts []string
	if detail.From != "" || detail.To != "" {
		from, to := detail.From, detail.To
		if event.Kind == store.PersonalAgentItemEventRehomed {
			from, to = cmp.Or(from, "inbox"), cmp.Or(to, "inbox")
		}
		switch {
		case event.Kind == store.PersonalAgentItemEventClaimed:
			parts = append(parts, "replaced "+from)
		case from != "" && to != "":
			parts = append(parts, from+" → "+to)
		default:
			parts = append(parts, from+to)
		}
	}
	if title := itemFileLine(detail.Title); title != "" {
		parts = append(parts, title)
	}
	if detail.SessionID != "" {
		parts = append(parts, detail.SessionID)
	}
	if detail.WorkspaceID != "" {
		parts = append(parts, detail.WorkspaceID)
	}
	if reason := itemFileLine(detail.Reason); reason != "" {
		parts = append(parts, reason)
	}
	if decision := itemFileLine(detail.Decision); decision != "" {
		parts = append(parts, decision)
	}
	if quote := itemFileLine(detail.Quote); quote != "" && event.Kind == store.PersonalAgentItemEventNeedsYouAnswered {
		parts = append(parts, "「"+quote+"」")
	}
	if len(parts) > 0 {
		line += "：" + strings.Join(parts, "，")
	}
	return line
}

// itemFileLine is text on one line.
func itemFileLine(text string) string { return strings.Join(strings.Fields(text), " ") }

// zonedTime is a stored RFC 3339 instant to the minute in location (UTC when
// nil), labelled with its UTC offset ("2026-11-21 11:09 UTC+8"), or the
// value on one line when it does not parse. The offset, unlike a zone
// abbreviation such as CST, reads one way only.
func zonedTime(value string, location *time.Location) string {
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return itemFileLine(value)
	}
	if location == nil {
		location = time.UTC
	}
	at = at.In(location)
	_, offset := at.Zone()
	label, sign := "UTC", "+"
	if offset < 0 {
		sign, offset = "-", -offset
	}
	if offset != 0 {
		label += sign + strconv.Itoa(offset/3600)
		if minutes := offset % 3600 / 60; minutes != 0 {
			label += fmt.Sprintf(":%02d", minutes)
		}
	}
	return at.Format("2006-01-02 15:04") + " " + label
}

// yamlValue is a value as YAML: JSON is YAML, and quotes every string.
func yamlValue(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return `""`
	}
	return strings.TrimSuffix(out.String(), "\n")
}
