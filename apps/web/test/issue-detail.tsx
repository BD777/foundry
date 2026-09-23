import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fixtureWorkspace,
  type Issue,
  type Run,
  type IssueContract,
} from "@foundry/protocol";
import { IssueDetailView } from "../src/features/issue-detail";
import { IssuesFeature } from "../src/features/issues";
import { issueStatuses } from "../src/lib/issue-meta";
import { Button } from "../src/components/ui/button";
import "../src/styles.css";
import "./issue-detail.css";

const contract = {
  id: "fixture-contract",
  revision: 1,
  status: "confirmed",
  contentDigest: "fixture-digest",
  goal: { text: "Keep one continuous Issue conversation", media: [] },
  inScope: [],
  outOfScope: [],
  constraints: [],
  criteria: [
    {
      id: "conversation",
      title: "Continuous conversation",
      statement: "Preserve conversation history",
      required: true,
      evaluationMode: "agent",
      proofKind: "behavior",
      rubric: { text: "Prior conversation remains visible", media: [] },
      evidenceRequirements: [],
    },
  ],
} as unknown as IssueContract;

const historical: Run = {
  id: "first",
  issueId: "issue_test",
  runtime: "claude",
  status: "completed",
  startedLabel: "earlier",
  startedAt: "2026-09-09T01:00:00Z",
  events: [
    {
      id: "read",
      runId: "first",
      at: "2026-09-09T01:00:01Z",
      label: "Read project instructions",
      detail: "Read AGENTS.md and the current roadmap.",
      level: "info",
    },
  ],
};
const initial: Issue = {
  id: "issue_test",
  shortId: "ISS-42",
  title: "Make Issue execution a continuous conversation",
  runtime: "claude",
  model: "test-model",
  status: "verifying",
  contractState: "confirmed",
  currentContractRevision: 1,
  sourceInput:
    "Reuse the Chat UI for Issue execution. Keep the goal and candidate details in a right-hand panel, and allow me to guide the agent.",
  priority: "medium",
  inferredTask: "",
  skills: [],
  acceptanceCriteria: [
    "Board and list use the same status labels.",
    "Execution history survives continuation.",
    "The details panel works on narrow screens.",
  ],
  checks: ["Candidate awaits human review"],
  updatedLabel: "just now",
  run: {
    id: "second",
    issueId: "issue_test",
    runtime: "claude",
    status: "completed",
    startedAt: "2026-09-09T02:00:00Z",
    startedLabel: "just now",
    environmentId: "env_test",
    environmentRevision: 2,
    events: [
      {
        id: "test",
        runId: "second",
        at: "2026-09-09T02:00:01Z",
        label: "Run targeted tests",
        detail: "Type check and conversation regressions passed.",
        level: "info",
      },
    ],
  },
  messages: [
    {
      id: "answer1",
      role: "assistant",
      runId: "first",
      createdAt: "2026-09-09T01:10:00Z",
      text: "I found the existing Chat UI. The shared transcript already handles **Markdown**, tool activity, and long conversations.",
    },
    {
      id: "feedback",
      role: "user",
      createdAt: "2026-09-09T01:30:00Z",
      text: "Keep the candidate diff in the right panel too.",
    },
    {
      id: "answer2",
      role: "assistant",
      runId: "second",
      createdAt: "2026-09-09T02:10:00Z",
      text: "The Issue conversation is ready.\n\n- The main area reuses Chat.\n- Details and Changes live in the right panel.\n- Interrupted work keeps its candidate.\n\nYou can review the change or send feedback to continue.",
    },
  ],
};

function Fixture() {
  const [board, setBoard] = useState(false);
  const [issue, setIssue] = useState(initial);
  const [notice, setNotice] = useState("Fixture ready — no real execution");
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/candidate-review"))
      return Response.json({
        revision: 2,
        review: {
          cwd: "/candidate/workspace",
          repositories: [
            {
              path: ".",
              baseline: "abc1234567",
              candidate: "def1234567",
              diff: "- Separate Runs screen\n+ One continuous Issue conversation",
              truncated: false,
            },
          ],
        },
      });
    if (url.endsWith("/environment"))
      return Response.json({ environment: undefined });
    if (url.includes("/contracts"))
      return Response.json({
        items: [contract],
        page: 1,
        pageSize: 100,
        total: 1,
      });
    if (url.endsWith("/review"))
      return Response.json({
        contractRevision: 1,
        criterionResults: [],
        blockingReasons: [],
        eligible: false,
      });
    if (!init?.method || init.method === "GET")
      return Response.json({ items: [], page: 1, pageSize: 100, total: 0 });
    if (url.endsWith("/abandon")) {
      setIssue((value) => ({ ...value, status: "abandoned" }));
      setNotice("Abandoned; history retained");
      return Response.json({ status: "abandoned" });
    }
    if (url.endsWith("/environment/cancel")) {
      setIssue((value) => ({
        ...value,
        status: "blocked",
        run: {
          ...value.run!,
          status: "canceled",
          error: "Stopped; candidate retained",
        },
      }));
      return Response.json({ status: "cancel_requested" });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    setNotice(
      `${url.endsWith("/steer") ? "Steered" : "Continued"}: ${body.message}`,
    );
    setIssue((value) => ({
      ...value,
      status: "in_progress",
      run: { ...value.run!, status: "running" },
      messages: [
        ...(value.messages ?? []),
        {
          id: crypto.randomUUID(),
          role: "user",
          text: body.message,
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    return Response.json({ status: "in_progress" });
  };
  return (
    <div className="issue-fixture">
      <nav className="issue-fixture-controls">
        <Button onClick={() => setBoard(true)}>Open Issues</Button>
        <Button onClick={() => setIssue(initial)}>Review</Button>
        <Button
          onClick={() =>
            setIssue({
              ...initial,
              sourceInput: "hi",
              status: "in_progress",
              messages: [
                {
                  id: "stream-followup",
                  role: "user",
                  text: "继续",
                  createdAt: "2026-09-09T07:32:34Z",
                },
              ],
              run: {
                ...initial.run!,
                id: "stream",
                status: "running",
                startedAt: "2026-09-09T07:32:34.306Z",
                events: [
                  {
                    id: "stream1",
                    runId: "stream",
                    label: "Response reset",
                    detail: "正在",
                    at: "2026-09-09T07:32:35Z",
                    level: "info",
                  },
                ],
              },
            })
          }
        >
          Start streaming replay
        </Button>
        <Button
          onClick={() =>
            setIssue((value) => ({
              ...value,
              run: {
                ...value.run!,
                events: [
                  ...value.run!.events,
                  {
                    id: crypto.randomUUID(),
                    runId: value.run!.id,
                    label: "Response delta",
                    detail: "输出",
                    at: new Date().toISOString(),
                    level: "info",
                  },
                ],
              },
            }))
          }
        >
          Append stream chunk
        </Button>
        <Button
          onClick={() =>
            setIssue((value) => ({
              ...value,
              status: "verifying",
              run: { ...value.run!, status: "completed" },
              messages: [
                ...(value.messages ?? []),
                {
                  id: "stream-final",
                  runId: value.run!.id,
                  role: "assistant",
                  text: "输出完成",
                  createdAt: new Date().toISOString(),
                },
              ],
            }))
          }
        >
          Finish streaming replay
        </Button>
        <Button
          onClick={() =>
            setIssue({
              ...initial,
              status: "in_progress",
              run: { ...initial.run!, status: "running" },
            })
          }
        >
          Running Claude
        </Button>
        <Button
          onClick={() =>
            setIssue({
              ...initial,
              runtime: "codex",
              status: "in_progress",
              run: { ...initial.run!, runtime: "codex", status: "running" },
            })
          }
        >
          Running Codex
        </Button>
        <Button
          onClick={() =>
            setIssue({
              ...initial,
              status: "blocked",
              run: {
                ...initial.run!,
                status: "failed",
                error: "Connection interrupted; candidate retained",
              },
            })
          }
        >
          System error
        </Button>
        <output>{notice}</output>
      </nav>
      {board ? (
        <IssuesFeature
          issues={issueStatuses.map((status, index) => ({
            ...initial,
            id: status,
            shortId: `ISS-${index + 1}`,
            title: `${status} example`,
            status,
            run: undefined,
            messages: [],
          }))}
          workspace={fixtureWorkspace}
          agents={[]}
          profiles={[]}
          providerHealth={[]}
          onEvent={(event) => {
            if (event.type === "issue.open.requested") {
              setBoard(false);
              setIssue({
                ...initial,
                id: event.issueId,
                status: event.issueId as Issue["status"],
              });
            }
          }}
        />
      ) : (
        <IssueDetailView
          issue={issue}
          history={[historical]}
          workspaceBaseline="main"
          deviceLabel="Test device"
          onBack={() => setBoard(true)}
          callbacks={{
            onAcceptIssue: () =>
              setIssue((value) => ({ ...value, status: "accepted" })),
            onDraftFromSource: setNotice,
            onNavigate: setNotice,
            onNewIssue: () => {},
            onNotice: setNotice,
            onRefresh: () => {},
            onRequestChanges: () => {},
            onStartProduction: () => {},
          }}
        />
      )}
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
