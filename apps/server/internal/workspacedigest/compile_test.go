package workspacedigest

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func baseSource() Source {
	return Source{
		UserID:       "usr_1",
		Role:         store.WorkspaceRoleOwner,
		Workspace:    store.WorkspaceProjection{ID: "ws_1", Name: "Budget", DeviceID: "dev_1", DeviceLabel: "MacBook"},
		DeviceOnline: true,
		Sessions: []store.AgentSession{
			{ID: "s_old", Title: "Old work", Status: "completed", LastActivityAt: "2026-10-01T00:00:00Z"},
			{ID: "s_new", Title: "New work", Status: "completed", LastActivityAt: "2026-10-10T00:00:00Z"},
			{ID: "s_name", Source: "naming", Title: "naming job", LastActivityAt: "2026-10-12T00:00:00Z"},
			{ID: "s_digest", Source: store.DigestSessionSource, Title: "digest job", LastActivityAt: "2026-10-12T00:00:00Z"},
		},
		Issues: []store.Issue{
			{ID: "iss_1", Title: "Open one", Status: "in_progress"},
			{ID: "iss_2", Title: "Done one", Status: "accepted"},
		},
		Skills:     []string{"xlsx", "pdf", "xlsx"},
		Connectors: []string{"Feishu"},
		Files:      []store.WorkspaceFileEntry{{Path: "README.md", Kind: "file", SizeLabel: "2 KB"}, {Path: "src", Kind: "directory"}},
	}
}

func TestCompileFillsTheDeterministicPart(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	record := Compile(baseSource(), nil, now)
	digest := record.Digest
	if digest.Name != "Budget" || digest.Kind != store.WorkspaceKindProject || digest.DeviceLabel != "MacBook" || !digest.DeviceOnline || digest.AccessRole != "owner" {
		t.Fatalf("identity = %+v", digest)
	}
	if len(digest.RecentSessions) != 2 || digest.RecentSessions[0].ID != "s_new" {
		t.Fatalf("recent sessions = %+v, want the two chats newest first, without Foundry's own", digest.RecentSessions)
	}
	if digest.LastActivityAt != "2026-10-10T00:00:00Z" {
		t.Fatalf("last activity = %q", digest.LastActivityAt)
	}
	if len(digest.OpenIssues) != 1 || digest.OpenIssues[0].ID != "iss_1" {
		t.Fatalf("open issues = %+v", digest.OpenIssues)
	}
	if fmt.Sprint(digest.Skills) != "[pdf xlsx]" || fmt.Sprint(digest.Connectors) != "[Feishu]" {
		t.Fatalf("skills %v connectors %v", digest.Skills, digest.Connectors)
	}
	if !digest.Dirty || record.FilesRev == "" || !record.NeedsIntro() {
		t.Fatalf("a new digest is dirty and wants its intro: %+v", record)
	}
}

func TestCompileKeepsAtMostFiveRecentSessions(t *testing.T) {
	source := baseSource()
	source.Sessions = nil
	for i := 0; i < 8; i++ {
		source.Sessions = append(source.Sessions, store.AgentSession{ID: fmt.Sprintf("s_%d", i), Title: fmt.Sprintf("work %d", i), LastActivityAt: fmt.Sprintf("2026-10-0%dT00:00:00Z", i+1)})
	}
	recent := Compile(source, nil, time.Now()).Digest.RecentSessions
	if len(recent) != 5 || recent[0].ID != "s_7" {
		t.Fatalf("recent = %+v", recent)
	}
}

// §3's triggers: a rename, a device going away or an archive changes the
// deterministic part only; a session's end, an Issue, skills, connectors or
// the instruction files make the summary dirty.
func TestCompileTellsWhatMakesTheSummaryDirty(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	summarized := Compile(baseSource(), nil, now)
	summarized.SummaryRev = summarized.ContentRev
	summarized.Digest.SummarizedAt = "2026-10-15T00:00:00Z"
	summarized.Digest.L0 = "A budget page"
	summarized.IntroRev = summarized.FilesRev
	summarized.Digest.Intro = "Tracks spending."
	// Saving the intro is a change of its own; settle it.
	summarized = Compile(baseSource(), &summarized, now)

	identity := map[string]func(*Source){
		"rename":         func(s *Source) { s.Workspace.Name = "Family budget" },
		"device offline": func(s *Source) { s.DeviceOnline = false },
		"archive":        func(s *Source) { s.Workspace.ArchivedAt = "2026-10-15T00:00:00Z" },
		"unavailable": func(s *Source) {
			s.Workspace.UnavailableOnDevice = &store.WorkspaceUnavailability{Reason: store.WorkspaceFolderMissing}
		},
		"role": func(s *Source) { s.Role = store.WorkspaceRoleViewer },
	}
	for name, change := range identity {
		source := baseSource()
		change(&source)
		next := Compile(source, &summarized, now.Add(time.Hour))
		if next.Digest.Dirty || next.Digest.SourceRev == summarized.Digest.SourceRev || next.Digest.CompiledAt == summarized.Digest.CompiledAt {
			t.Errorf("%s: dirty=%v, want the deterministic part updated and the summary clean", name, next.Digest.Dirty)
		}
		if next.Digest.L0 != "A budget page" || next.Digest.Intro != "Tracks spending." {
			t.Errorf("%s lost the summary or the intro: %+v", name, next.Digest)
		}
	}
	content := map[string]func(*Source){
		"session ended": func(s *Source) {
			s.Sessions = append(s.Sessions, store.AgentSession{ID: "s_3", Title: "Export", Status: "completed", LastActivityAt: "2026-10-14T00:00:00Z"})
		},
		"issue status": func(s *Source) { s.Issues[0].Status = "accepted" },
		"skill added":  func(s *Source) { s.Skills = append(s.Skills, "docx") },
		"connector":    func(s *Source) { s.Connectors = nil },
		"agents changed": func(s *Source) {
			s.Files = append(s.Files, store.WorkspaceFileEntry{Path: "AGENTS.md", Kind: "file", SizeLabel: "1 KB"})
		},
		"purpose": func(s *Source) { s.Purpose = "Track family spending" },
	}
	for name, change := range content {
		source := baseSource()
		change(&source)
		if next := Compile(source, &summarized, now.Add(time.Hour)); !next.Digest.Dirty {
			t.Errorf("%s: want the summary dirty", name)
		}
	}
	if again := Compile(baseSource(), &summarized, now.Add(time.Hour)); again.Digest.Dirty || again.Digest.CompiledAt != summarized.Digest.CompiledAt {
		t.Errorf("nothing changed: dirty=%v compiledAt=%s", again.Digest.Dirty, again.Digest.CompiledAt)
	}
	source := baseSource()
	source.Files = nil
	if gone := Compile(source, &summarized, now); gone.Digest.Intro != "" || gone.NeedsIntro() {
		t.Errorf("an intro whose files are gone stays: %+v", gone)
	}
}

func TestFirstParagraphSkipsFrontMatterHeadingsAndBadges(t *testing.T) {
	content := "---\ntitle: x\n---\n# Budget\n\n[![ci](x)](y)\n<p align=center>logo</p>\n\nTracks family\nspending by month.\n\nSecond paragraph.\n"
	if got := FirstParagraph(content); got != "Tracks family spending by month." {
		t.Fatalf("FirstParagraph = %q", got)
	}
	if got := FirstParagraph("```sh\nmake\n```\n"); got != "" {
		t.Fatalf("code only = %q", got)
	}
}

func TestCompileDevice(t *testing.T) {
	device := CompileDevice(DeviceSource{
		Device: store.DeviceProjection{ID: "dev_1", Label: "MacBook", System: &store.DeviceSystem{OS: "darwin", OSVersion: "15.1"},
			Resources: []store.DeviceResource{{Kind: "browser", Available: true}, {Kind: "screen", Available: false}}},
		Online:         true,
		Providers:      []store.ProviderHealth{{Provider: "claude", Status: "healthy"}, {Provider: "codex", Status: "unavailable"}},
		ModelServices:  []string{"Kimi"},
		WorkspaceCount: 3,
	}, time.Now())
	if device.System != "macOS 15.1" || fmt.Sprint(device.Runtimes) != "[claude]" || fmt.Sprint(device.Resources) != "[browser]" || device.WorkspaceCount != 3 {
		t.Fatalf("device = %+v", device)
	}
}

// A project ranks by what the person asked there before any summary: its
// chats' and sessions' titles and first messages, cleaned of markup.
func TestCompileKeepsThePersonsRequestsAsHistory(t *testing.T) {
	source := baseSource()
	source.Chats = []store.ChatThread{
		{ID: "native_claude_1", Title: "[Image #1] 简历再精简一版", Preview: "[Image #1] 简历再精简一版", UpdatedAt: "2026-10-14T00:00:00Z"},
		{ID: "native_claude_2", Title: "This session is being continued from a previous conversation", Preview: "<pasted_content id=\"1\"> 看看 https://example.com 的报价", UpdatedAt: "2026-10-13T00:00:00Z"},
	}
	record := Compile(source, nil, time.Now())
	if record.Digest.RecentSessions[0].ID != "native_claude_1" || record.Digest.RecentSessions[0].Title != "简历再精简一版" {
		t.Fatalf("recent = %+v", record.Digest.RecentSessions)
	}
	if fmt.Sprint(record.History[:3]) != "[简历再精简一版 看看 的报价 New work]" {
		t.Fatalf("history = %q", record.History)
	}
	if fmt.Sprint(record.Files) != "[README.md src]" {
		t.Fatalf("files = %v", record.Files)
	}
	candidates := RankRecords("帮我改一下简历", []store.WorkspaceDigestRecord{record, {Digest: store.WorkspaceDigest{WorkspaceID: "ws_2", Name: "Other"}}}, nil, time.Now(), 3)
	if len(candidates) != 1 || candidates[0].WorkspaceID != "ws_1" || !strings.Contains(candidates[0].Reason, "earlier requests") {
		t.Fatalf("candidates = %+v", candidates)
	}
}

func TestInstructionContentRevisionDetectsSameSizeChangesWithoutClockChurn(t *testing.T) {
	now := time.Now()
	source := Source{UserID: "person", Workspace: store.WorkspaceProjection{ID: "context"}, Files: []store.WorkspaceFileEntry{{Path: "AGENTS.md", Kind: "file", SizeLabel: "1 KB", UpdatedLabel: "local", Revision: "sha256:first"}}}
	first := Compile(source, nil, now)
	source.Files[0].Revision = "sha256:second"
	second := Compile(source, &first, now)
	if first.ContentRev == second.ContentRev {
		t.Fatal("same-size context change lost")
	}
	source.Files[0].UpdatedLabel = "a different presentation timestamp"
	third := Compile(source, &second, now.Add(time.Minute))
	if second.ContentRev != third.ContentRev {
		t.Fatal("unchanged content would rerun maintenance")
	}
}
