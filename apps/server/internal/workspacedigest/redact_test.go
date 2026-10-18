package workspacedigest

import (
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The dev sample: a server's IP and login user pasted into a request.
const pastedServer = "配一下这个机器到本地 ~/.ssh/config，准备用来跑 rapidmaker IP：5.60.131.62 user：ec2-user"

var leaked = []string{"5.60.131.62", "ec2-user", "sk-proj-AbCdEf1234567890GhIjKlMnOp", "ops@example.com", "13812345678", "hunter2", "10.0.3.17"}

func assertNoLeak(t *testing.T, where, text string) {
	t.Helper()
	for _, secret := range leaked {
		if strings.Contains(text, secret) {
			t.Errorf("%s holds %q: %q", where, secret, text)
		}
	}
}

func secretSource() Source {
	source := baseSource()
	source.Purpose = "跑 rapidmaker 的 GPU 机器，联系 ops@example.com"
	source.Sessions = []store.AgentSession{
		{ID: "s_ssh", Prompt: pastedServer + "\n后面是日志", Status: "completed", LastActivityAt: "2026-10-12T00:00:00Z"},
		{ID: "s_key", Title: "Rotate the OpenAI key sk-proj-AbCdEf1234567890GhIjKlMnOp for the summarizer", Status: "completed", LastActivityAt: "2026-10-11T00:00:00Z"},
		{ID: "s_long", Title: strings.Repeat("部署 rapidmaker ", 6) + "ssh deploy@10.0.3.17 password: hunter2", Status: "completed", LastActivityAt: "2026-10-10T00:00:00Z"},
	}
	source.Chats = []store.ChatThread{{ID: "chat_1", Title: "简历投递，电话 13812345678", Preview: "帮我改简历", UpdatedAt: "2026-10-09T00:00:00Z"}}
	source.Issues = []store.Issue{{ID: "iss_1", Title: "Server 5.60.131.62 unreachable from sg-chaos", Status: "open"}}
	source.Files = append(source.Files, store.WorkspaceFileEntry{Path: "ec2-user@5.60.131.62.pem", Kind: "file"})
	return source
}

// Nothing of the person's history is kept, shown or ranked on with its
// secrets, and what routes a request there stays.
func TestCompileRedactsThePersonsHistory(t *testing.T) {
	record := Compile(secretSource(), nil, time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC))
	digest := record.Digest
	assertNoLeak(t, "purpose", digest.Purpose)
	for _, session := range digest.RecentSessions {
		assertNoLeak(t, "recent session title", session.Title)
	}
	for _, issue := range digest.OpenIssues {
		assertNoLeak(t, "issue title", issue.Title)
	}
	for _, text := range record.History {
		assertNoLeak(t, "history", text)
	}
	for _, name := range record.Files {
		assertNoLeak(t, "file", name)
	}
	history := strings.Join(record.History, "\n")
	for _, kept := range []string{"配一下这个机器到本地", "准备用来跑 rapidmaker", "IP：‹ip›", "Rotate the OpenAI key ‹secret›", "简历投递", "帮我改简历"} {
		if !strings.Contains(history, kept) {
			t.Errorf("history lost %q: %q", kept, history)
		}
	}
	if !strings.Contains(digest.Purpose, "rapidmaker") || !strings.Contains(digest.OpenIssues[0].Title, "unreachable from sg-chaos") {
		t.Errorf("routing words lost: %q, %q", digest.Purpose, digest.OpenIssues[0].Title)
	}
	records := []store.WorkspaceDigestRecord{record}
	if candidates := RankRecords("5.60.131.62 ec2", records, nil, time.Now(), 0); len(candidates) != 0 {
		t.Errorf("ranked on a redacted address: %+v", candidates)
	}
	if candidates := RankRecords("配置 ssh 跑 rapidmaker", records, nil, time.Now(), 0); len(candidates) != 1 {
		t.Errorf("routing words no longer rank the project: %+v", candidates)
	}
}

// The summary session reads nothing it should not: neither what a stored
// digest from before redaction holds, nor instruction files, answers or
// file names with secrets; and its answer keeps none it echoed.
func TestSummaryPromptAndAnswerAreRedacted(t *testing.T) {
	digest := store.WorkspaceDigest{
		WorkspaceID:    "ws_1",
		Name:           "rapidmaker",
		Purpose:        "GPU box at 5.60.131.62",
		Intro:          "Deploy with ssh ec2-user@5.60.131.62.",
		RecentSessions: []store.WorkspaceDigestSession{{ID: "s1", Title: "OPENAI key sk-proj-AbCdEf1234567890GhIjKlMnOp"}},
		OpenIssues:     []store.WorkspaceDigestIssue{{ID: "iss_1", Title: "call 13812345678"}},
		L0:             "rapidmaker on 5.60.131.62",
		Summary:        "Runs rapidmaker; login ec2-user@5.60.131.62.",
		RouteWhen:      []string{"rapidmaker 机器 5.60.131.62"},
		SummarizedAt:   "2026-10-14T00:00:00Z",
	}
	prompt, err := SummaryPrompt(SummaryInput{
		Digest:       digest,
		Instructions: []InstructionExcerpt{{Path: "AGENTS.md", Content: "# rapidmaker\nRenders video on the GPU box. DB: postgres://app:hunter2@10.0.3.17:5432/main"}},
		Work:         []WorkBrief{{Title: "Set up ssh", Status: "completed", Answer: "Added Host gpu with HostName 5.60.131.62 and User ec2-user; mail ops@example.com"}},
		Requests:     []string{pastedServer},
		Files:        []string{"ec2-user@5.60.131.62.pem", "render/"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertNoLeak(t, "summary prompt", prompt)
	for _, kept := range []string{"rapidmaker", "Renders video on the GPU box", "准备用来跑 rapidmaker", `"render/"`, "‹ip›"} {
		if !strings.Contains(prompt, kept) {
			t.Errorf("prompt lost %q", kept)
		}
	}
	summary, err := ParseSummary(`{"l0":"rapidmaker 渲染机 5.60.131.62","summary":"在 ec2-user@5.60.131.62 上跑 rapidmaker，联系 ops@example.com。","routeWhen":["rapidmaker 渲染 / render jobs","ssh 13812345678"],"notWhen":[]}`)
	if err != nil {
		t.Fatal(err)
	}
	assertNoLeak(t, "summary", summary.L0+summary.Summary+strings.Join(summary.RouteWhen, " "))
	if !strings.Contains(summary.L0, "rapidmaker 渲染机") || summary.RouteWhen[0] != "rapidmaker 渲染 / render jobs" {
		t.Errorf("summary lost its meaning: %+v", summary)
	}
}
