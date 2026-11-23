package workspacedigest

import (
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/redact"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// The assistant's per-project summary files: Foundry writes them into its
// home from the same digests and summaries the project index is made from,
// so the runtime reads what it manages natively instead of calling a
// ranking tool. The index stays the short list and points at them.

const (
	// ProjectFilesDir is where the summary files live in the assistant's
	// home.
	ProjectFilesDir = ".foundry/projects"
	// ProjectManifestPath lists the files Foundry wrote, so the Worker can
	// remove the ones a project no longer has.
	ProjectManifestPath = ProjectFilesDir + "/.manifest"
	// projectSummaryChars bounds the model summary in a file, as §3 bounds it.
	projectSummaryChars = 600
	projectSlugRunes    = 60
)

// ProjectFiles are the summary files of the digest's projects, plus the
// manifest of their names, in a stable order. Archived projects and the
// assistant's own workspace have none. mentions are each project's terms
// (Service.Mentions), by workspace id.
func ProjectFiles(digests []store.WorkspaceDigest, notes map[string]bool, mentions map[string][]Mention, now time.Time) []personalagent.WorkspaceFile {
	projects := projectDigests(digests)
	slugs := ProjectSlugs(digests)
	files := make([]personalagent.WorkspaceFile, 0, len(projects)+1)
	names := make([]string, 0, len(projects))
	for _, digest := range projects {
		name := slugs[digest.WorkspaceID] + ".md"
		names = append(names, name)
		files = append(files, personalagent.WorkspaceFile{
			Path:    ProjectFilesDir + "/" + name,
			Content: projectFile(digest, notes[digest.WorkspaceID], mentions[digest.WorkspaceID], now),
		})
	}
	manifest := strings.Join(names, "\n")
	if manifest != "" {
		manifest += "\n"
	}
	return append(files, personalagent.WorkspaceFile{Path: ProjectManifestPath, Content: manifest})
}

// ProjectSlugs maps every project's workspace id to its file's name
// without .md. A name is slugged from the project's name; copies of the
// same name on different devices get the device's name, and only those
// still colliding the workspace id, so every file stays distinct.
func ProjectSlugs(digests []store.WorkspaceDigest) map[string]string {
	projects := projectDigests(digests)
	counts := map[string]int{}
	for _, digest := range projects {
		counts[projectSlug(digest.Name)]++
	}
	slugs := map[string]string{}
	used := map[string]bool{}
	for _, digest := range projects {
		slug := projectSlug(digest.Name)
		if counts[slug] > 1 {
			if device := projectSlug(digest.DeviceLabel); device != "" {
				slug += "-" + device
			}
			if used[slug] {
				slug = projectSlug(digest.Name) + "-" + shortWorkspaceID(digest.WorkspaceID)
			}
		}
		for used[slug] {
			slug += "-" + shortWorkspaceID(digest.WorkspaceID)
		}
		used[slug] = true
		slugs[digest.WorkspaceID] = slug
	}
	return slugs
}

// projectDigests are the digests that get a file: not archived, not the
// assistant's own workspace, in workspace-id order so collision suffixes
// stay stable.
func projectDigests(digests []store.WorkspaceDigest) []store.WorkspaceDigest {
	projects := make([]store.WorkspaceDigest, 0, len(digests))
	for _, digest := range digests {
		if digest.Archived || digest.Kind == store.WorkspaceKindPersonalAgent {
			continue
		}
		projects = append(projects, digest)
	}
	sort.SliceStable(projects, func(i, j int) bool { return projects[i].WorkspaceID < projects[j].WorkspaceID })
	return projects
}

// projectSlug is a name as a file name: lower-case letters and digits,
// other runs as one hyphen, at most projectSlugRunes.
func projectSlug(name string) string {
	var out strings.Builder
	hyphen := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			out.WriteRune(r)
			hyphen = false
		case out.Len() > 0 && !hyphen:
			out.WriteByte('-')
			hyphen = true
		}
	}
	slug := strings.Trim(out.String(), "-")
	if runes := []rune(slug); len(runes) > projectSlugRunes {
		slug = strings.TrimRight(string(runes[:projectSlugRunes]), "-")
	}
	if slug == "" {
		return "project"
	}
	return slug
}

// shortWorkspaceID is the tail of a workspace id, for a file name.
func shortWorkspaceID(id string) string {
	var out strings.Builder
	for _, r := range id {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			out.WriteRune(r)
		}
	}
	value := out.String()
	if len(value) > 8 {
		value = value[len(value)-8:]
	}
	if value == "" {
		return "workspace"
	}
	return value
}

// projectFile is one project's summary as the assistant reads it: the
// digest's facts and summary, and where its own note is.
func projectFile(digest store.WorkspaceDigest, hasNote bool, mentions []Mention, now time.Time) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# 『%s』\n\n", oneLine(redact.Text(digest.Name)))
	line := func(key, value string) {
		value = strings.TrimSpace(value)
		if value != "" {
			fmt.Fprintf(&out, "- %s: %s\n", key, value)
		}
	}
	line("id", digest.WorkspaceID)
	where := oneLine(redact.Text(digest.DeviceLabel))
	if where == "" {
		where = digest.DeviceID
	}
	state := "offline"
	if digest.DeviceOnline {
		state = "online"
	}
	if digest.Unavailable {
		state += ", folder unavailable"
	}
	line("device", where+" ("+digest.DeviceID+"), "+state)
	if digest.AccessRole != "" && digest.AccessRole != store.WorkspaceRoleOwner {
		line("access", digest.AccessRole)
	}
	line("purpose", oneLine(redact.Text(digest.Purpose)))
	if summary := strings.TrimSpace(redact.Text(digest.Summary)); summary != "" {
		line("summary", textcut.Excerpt(oneLine(summary), projectSummaryChars))
	} else {
		line("summary", "(not summarized yet)")
	}
	line("last active", projectTime(digest.LastActivityAt))
	line("git", gitState(digest))
	if digest.SummarizedAt != "" {
		line("summarized", projectTime(digest.SummarizedAt))
	}
	asOf := "as of " + now.UTC().Format("2006-01-02 15:04") + " UTC"
	if Stale(digest, now) {
		asOf += "; the summary may be out of date"
	}
	line("state", asOf)

	section := func(title string, values []string) {
		values = compact(values)
		if len(values) == 0 {
			return
		}
		fmt.Fprintf(&out, "\n## %s\n\n", title)
		for _, value := range values {
			fmt.Fprintf(&out, "- %s\n", value)
		}
	}
	section("Route here when", redactAllNotes(digest.RouteWhen))
	section("Not when", redactAllNotes(digest.NotWhen))
	section("Skills", redactAllNotes(digest.Skills))
	section("Connectors", redactAllNotes(digest.Connectors))
	sessions := make([]string, 0, len(digest.RecentSessions))
	for _, session := range digest.RecentSessions {
		title := oneLine(redact.Text(session.Title))
		if title == "" {
			continue
		}
		line := title
		if session.Status != "" {
			line += " — " + session.Status
		}
		if at := projectTime(session.UpdatedAt); at != "" {
			line += ", " + at
		}
		sessions = append(sessions, line)
	}
	section("Recent sessions", sessions)
	issues := make([]string, 0, len(digest.OpenIssues))
	for _, issue := range digest.OpenIssues {
		if title := oneLine(redact.Text(issue.Title)); title != "" {
			issues = append(issues, title)
		}
	}
	section("Open Issues", issues)
	if len(mentions) > 0 {
		named := make([]string, len(mentions))
		for i, mention := range mentions {
			named[i] = fmt.Sprintf("%s (%d)", mention.Term, mention.Count)
		}
		fmt.Fprintf(&out, "\n## Names talked about here\n\nHow often its chats, sessions and file names use these names, the ones that set it apart from the person's other projects. A name here was talked about here; where the thing itself lives or runs, the summary or the project says. find_in_projects looks up any name.\n\n%s\n", strings.Join(named, ", "))
	}
	if hasNote {
		section("Your note", []string{"cards/" + digest.WorkspaceID + ".md"})
	}
	return out.String()
}

func gitState(digest store.WorkspaceDigest) string {
	parts := []string{}
	if digest.GitBranch != "" {
		parts = append(parts, digest.GitBranch)
	}
	if digest.GitDirty != nil {
		if *digest.GitDirty {
			parts = append(parts, "uncommitted changes")
		} else {
			parts = append(parts, "clean")
		}
	}
	return strings.Join(parts, ", ")
}

func redactAllNotes(values []string) []string {
	redacted := make([]string, len(values))
	for i, value := range values {
		redacted[i] = oneLine(redact.Text(value))
	}
	return redacted
}

func compact(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}

func projectTime(value string) string {
	if at, ok := parseTime(value); ok {
		return at.UTC().Format("2006-01-02 15:04") + " UTC"
	}
	return oneLine(value)
}

func oneLine(text string) string { return strings.Join(strings.Fields(text), " ") }
