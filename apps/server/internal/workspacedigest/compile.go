package workspacedigest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/redact"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Source is everything one person's digest of one workspace is compiled
// from: what the server keeps and its devices reported. httpapi gathers it
// (Sources.Collect) with only what the person's role reads.
type Source struct {
	UserID       string
	Workspace    store.WorkspaceProjection
	Role         string
	Purpose      string
	DeviceOnline bool
	// Sessions in any order; Foundry's own (naming, diagnostics, digests)
	// are left out here.
	Sessions []store.AgentSession
	// Chats are the workspace's other chats (native Claude Code / Codex
	// sessions its device reported), with the titles the person or naming
	// gave them.
	Chats      []store.ChatThread
	Issues     []store.Issue
	Skills     []string
	Connectors []string
	// Files are the top-level entries its device reported: which of
	// AGENTS.md, CLAUDE.md and README the intro can come from, and their
	// sizes, to tell when they changed.
	Files []store.WorkspaceFileEntry
	// Git is what a live check last read, when one did.
	GitBranch string
	GitDirty  *bool
}

// Sessions Foundry starts for itself say nothing of what a project is for.
var utilitySources = map[string]bool{"naming": true, "diagnostic": true, store.DigestSessionSource: true}

// Issues in these statuses are finished.
var closedIssueStatuses = map[string]bool{"accepted": true, "abandoned": true}

const (
	maxOpenIssues  = 10
	maxTitleRunes  = 80
	maxIntroRunes  = 400
	revBytes       = 8
	untitledPrompt = "(untitled)"
)

// Compile computes the deterministic part of src's digest. previous, the
// stored record (nil for none), lends what src does not carry: the summary
// and its loop, the intro, and CompiledAt while nothing changed.
func Compile(src Source, previous *store.WorkspaceDigestRecord, now time.Time) store.WorkspaceDigestRecord {
	workspace := src.Workspace
	digest := store.WorkspaceDigest{
		UserID:         src.UserID,
		WorkspaceID:    workspace.ID,
		Name:           strings.TrimSpace(workspace.Name),
		Kind:           workspace.Kind,
		Purpose:        strings.TrimSpace(redact.Text(src.Purpose)),
		DeviceID:       workspace.DeviceID,
		DeviceLabel:    workspace.DeviceLabel,
		DeviceOnline:   src.DeviceOnline,
		AccessRole:     src.Role,
		Archived:       workspace.ArchivedAt != "",
		Unavailable:    workspace.UnavailableOnDevice != nil,
		RecentSessions: recentSessions(src.Sessions, src.Chats),
		OpenIssues:     openIssues(src.Issues),
		Skills:         sortedUnique(src.Skills),
		Connectors:     sortedUnique(src.Connectors),
		GitBranch:      src.GitBranch,
		GitDirty:       src.GitDirty,
		LastActivityAt: lastActivity(src.Sessions, src.Chats),
		RouteWhen:      []string{},
		NotWhen:        []string{},
	}
	if digest.Kind == "" {
		digest.Kind = store.WorkspaceKindProject
	}
	record := store.WorkspaceDigestRecord{FilesRev: instructionFilesRev(src.Files), History: history(src.Sessions, src.Chats), Files: fileNames(src.Files)}
	if previous != nil {
		record.IntroRev = previous.IntroRev
		record.SummaryRev = previous.SummaryRev
		record.SummaryDueAt = previous.SummaryDueAt
		record.SummarySessionID = previous.SummarySessionID
		record.PendingRev = previous.PendingRev
		digest.Intro = previous.Digest.Intro
		digest.L0 = previous.Digest.L0
		digest.Summary = previous.Digest.Summary
		digest.RouteWhen = nonNil(previous.Digest.RouteWhen)
		digest.NotWhen = nonNil(previous.Digest.NotWhen)
		digest.SummarizedAt = previous.Digest.SummarizedAt
	}
	if record.FilesRev == "" {
		// No instruction file left to read an intro from.
		digest.Intro, record.IntroRev = "", ""
	}
	record.ContentRev = rev(struct {
		Purpose    string
		Sessions   []store.WorkspaceDigestSession
		Issues     []store.WorkspaceDigestIssue
		Skills     []string
		Connectors []string
		Files      string
	}{digest.Purpose, contentSessions(digest.RecentSessions), digest.OpenIssues, digest.Skills, digest.Connectors, record.FilesRev})
	digest.SourceRev = rev(struct {
		Content                     string
		Name, Kind, Device, Label   string
		Online, Archived, Unserved  bool
		Role, Branch, Intro, Active string
		Dirty                       *bool
		History, Files              []string
	}{record.ContentRev, digest.Name, digest.Kind, digest.DeviceID, digest.DeviceLabel,
		digest.DeviceOnline, digest.Archived, digest.Unavailable,
		digest.AccessRole, digest.GitBranch, digest.Intro, digest.LastActivityAt, digest.GitDirty,
		record.History, record.Files})
	digest.CompiledAt = formatTime(now)
	if previous != nil && previous.Digest.SourceRev == digest.SourceRev && previous.Digest.CompiledAt != "" {
		digest.CompiledAt = previous.Digest.CompiledAt
	}
	digest.Dirty = record.ContentRev != record.SummaryRev
	record.Digest = digest
	return record
}

// InstructionFiles are the files an intro and a summary read, in order of
// preference, among those reported.
func InstructionFiles(files []store.WorkspaceFileEntry) []string {
	found := []string{}
	for _, name := range []string{"AGENTS.md", "CLAUDE.md", "README.md", "README", "README.markdown", "README.txt"} {
		for _, file := range files {
			if file.Kind != "directory" && strings.EqualFold(file.Path, name) {
				found = append(found, file.Path)
				break
			}
		}
	}
	return found
}

func instructionFilesRev(files []store.WorkspaceFileEntry) string {
	names := InstructionFiles(files)
	if len(names) == 0 {
		return ""
	}
	parts := []string{}
	for _, file := range files {
		for _, name := range names {
			if file.Path == name {
				parts = append(parts, file.Path+"="+file.SizeLabel+"@"+file.UpdatedLabel)
			}
		}
	}
	sort.Strings(parts)
	return rev(parts)
}

// FirstParagraph is a file's intro: its first paragraph of prose, without
// front matter, headings, badges, code or HTML, at most 400 characters.
func FirstParagraph(content string) string {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if strings.HasPrefix(content, "---\n") {
		if end := strings.Index(content[4:], "\n---"); end >= 0 {
			content = content[4+end+4:]
		}
	}
	lines := []string{}
	fenced := false
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fenced = !fenced
			continue
		}
		if fenced {
			continue
		}
		prose := trimmed != "" && !strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "<") &&
			!strings.HasPrefix(trimmed, "![") && !strings.HasPrefix(trimmed, "[![") &&
			!strings.HasPrefix(trimmed, "|") && !strings.HasPrefix(trimmed, "---") && !strings.HasPrefix(trimmed, "===")
		if !prose {
			if len(lines) > 0 {
				break
			}
			continue
		}
		lines = append(lines, trimmed)
	}
	return truncateRunes(redact.Text(strings.Join(lines, " ")), maxIntroRunes)
}

// activity is one session or chat, as a digest reads it.
type activity struct {
	id, title, prompt, status string
	at                        time.Time
}

// activities are the person's sessions and chats there, newest first,
// without Foundry's own.
func activities(sessions []store.AgentSession, chats []store.ChatThread) []activity {
	all := []activity{}
	seen := map[string]bool{}
	for _, session := range sessions {
		if utilitySources[session.Source] || seen[session.ID] {
			continue
		}
		seen[session.ID] = true
		title := truncateRunes(cleanRequest(sessionTitle(session)), maxTitleRunes)
		if title == "" {
			title = untitledPrompt
		}
		all = append(all, activity{id: session.ID, title: title, prompt: session.Prompt, status: session.Status, at: sessionActivity(session)})
	}
	for _, chat := range chats {
		if seen[chat.ID] || (chat.NativeSessionID != "" && seen[chat.NativeSessionID]) {
			continue
		}
		seen[chat.ID] = true
		title := cleanRequest(chat.Title)
		if title == "" {
			title = cleanRequest(chat.Preview)
		}
		if title == "" {
			title = untitledPrompt
		}
		at, _ := parseTime(chat.UpdatedAt)
		all = append(all, activity{id: chat.ID, title: truncateRunes(title, maxTitleRunes), prompt: chat.Preview, status: chat.Status, at: at})
	}
	sort.SliceStable(all, func(i, j int) bool {
		if !all[i].at.Equal(all[j].at) {
			return all[i].at.After(all[j].at)
		}
		return all[i].id > all[j].id
	})
	return all
}

func recentSessions(sessions []store.AgentSession, chats []store.ChatThread) []store.WorkspaceDigestSession {
	recent := []store.WorkspaceDigestSession{}
	for _, item := range activities(sessions, chats) {
		if len(recent) == personalagent.DigestRecentSessions {
			break
		}
		recent = append(recent, store.WorkspaceDigestSession{ID: item.id, Title: item.title, Status: item.status, UpdatedAt: formatTimeOrEmpty(item.at)})
	}
	return recent
}

const (
	maxHistoryItems = 80
	maxHistoryRunes = 200
)

// history is the person's own words there: each session's or chat's title
// and first message, cleaned of pasted markup, newest first, without
// repeats.
func history(sessions []store.AgentSession, chats []store.ChatThread) []string {
	items := []string{}
	seen := map[string]bool{}
	for _, item := range activities(sessions, chats) {
		if len(items) == maxHistoryItems {
			break
		}
		for _, text := range []string{item.title, item.prompt} {
			text = truncateRunes(cleanRequest(text), maxHistoryRunes)
			if text == "" || text == untitledPrompt || seen[text] {
				continue
			}
			seen[text] = true
			items = append(items, text)
		}
	}
	return items
}

var (
	markupPattern = regexp.MustCompile("\\[Image #\\d+\\]|<[^>]{0,200}>|https?://\\S+|\\b(?:sess|native_claude|native_codex|ws|iss|dev)_[A-Za-z0-9_-]+|```[^`]*(?:```|$)")
	// Text a runtime writes into a session, not the person.
	machinePrefixes = []string{"this session is being continued", "caveat:", "<local-command", "<command-", "[request interrupted"}
)

// cleanRequest is a message as the person wrote it: without secrets and
// connection details (redact.Text), images, pasted blocks, links, ids or
// code, on one line. It is what every title and request of the person's
// history passes before a digest keeps, shows or ranks by it.
func cleanRequest(text string) string {
	lower := strings.ToLower(strings.TrimSpace(text))
	for _, prefix := range machinePrefixes {
		if strings.HasPrefix(lower, prefix) {
			return ""
		}
	}
	text = markupPattern.ReplaceAllString(redact.Text(requestStart(text)), " ")
	return strings.Join(strings.Fields(text), " ")
}

// maxRequestBytes is how much of a message a digest reads: far more than
// it keeps (maxHistoryRunes), and a pasted log is not redacted whole.
const maxRequestBytes = 4096

// requestStart is the start of a long message, ending before its last
// word so a secret is not cut short of its pattern.
func requestStart(text string) string {
	if len(text) <= maxRequestBytes {
		return text
	}
	text = truncateBytes(text, maxRequestBytes)
	if space := strings.LastIndexFunc(text, unicode.IsSpace); space > 0 {
		text = text[:space]
	}
	return text
}

func fileNames(files []store.WorkspaceFileEntry) []string {
	names := []string{}
	for _, file := range files {
		names = append(names, redact.Text(file.Path))
	}
	sort.Strings(names)
	return names
}

// contentSessions are the recent sessions as a summary reads them: what
// they were about and how they ended, not when.
func contentSessions(sessions []store.WorkspaceDigestSession) []store.WorkspaceDigestSession {
	content := make([]store.WorkspaceDigestSession, len(sessions))
	for i, session := range sessions {
		content[i] = store.WorkspaceDigestSession{ID: session.ID, Title: session.Title, Status: session.Status}
	}
	return content
}

// sessionTitle is a session's title or its prompt's first line, whole:
// it is cut after it is cleaned, so no secret is cut short of its pattern.
func sessionTitle(session store.AgentSession) string {
	title := strings.TrimSpace(session.Title)
	if title == "" {
		title = strings.TrimSpace(session.Prompt)
		if newline := strings.IndexByte(title, '\n'); newline >= 0 {
			title = strings.TrimSpace(title[:newline])
		}
	}
	if title == "" {
		return untitledPrompt
	}
	return title
}

func sessionActivity(session store.AgentSession) time.Time {
	for _, value := range []string{session.LastActivityAt, session.ActivityAt, session.CompletedAt, session.StartedAt} {
		if at, ok := parseTime(value); ok {
			return at
		}
	}
	return time.Time{}
}

func lastActivity(sessions []store.AgentSession, chats []store.ChatThread) string {
	if all := activities(sessions, chats); len(all) > 0 {
		return formatTimeOrEmpty(all[0].at)
	}
	return ""
}

func openIssues(issues []store.Issue) []store.WorkspaceDigestIssue {
	open := []store.WorkspaceDigestIssue{}
	for _, issue := range issues {
		if closedIssueStatuses[issue.Status] {
			continue
		}
		open = append(open, store.WorkspaceDigestIssue{ID: issue.ID, Title: truncateRunes(strings.TrimSpace(redact.Text(issue.Title)), maxTitleRunes), Status: issue.Status})
	}
	sort.SliceStable(open, func(i, j int) bool { return open[i].ID > open[j].ID })
	if len(open) > maxOpenIssues {
		open = open[:maxOpenIssues]
	}
	return open
}

func sortedUnique(values []string) []string {
	seen := map[string]bool{}
	unique := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			unique = append(unique, value)
		}
	}
	sort.Strings(unique)
	return unique
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func rev(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:revBytes])
}

func truncateRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

func parseTime(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, value)
	return at, err == nil
}

// formatTime writes times at a fixed width, so the store compares them as
// text.
func formatTime(at time.Time) string {
	return at.UTC().Format(time.RFC3339)
}

func formatTimeOrEmpty(at time.Time) string {
	if at.IsZero() {
		return ""
	}
	return formatTime(at)
}
