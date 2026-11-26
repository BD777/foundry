import { linkCodexSkills } from "../../skills/codex-native-skills.js";
import type { ManagedSkillRuntime } from "../../skills/skill-materializer.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  parseAgentQuestionReply,
  sessionEventLabels,
  type AgentSession,
  type TranscriptMessage,
} from "@bd777/foundry-protocol";
import { AcpClient } from "../../harness/agent-runtime/acp-client.js";
import { acquireRuntime } from "../../harness/agent-runtime/maintenance.js";
import {
  antigravityInvocation,
  requireAntigravityLogin,
} from "../../harness/native/antigravity.js";
import {
  profileID,
  type AgentProfileLocalConfig,
} from "../../harness/profiles.js";
import { PendingReplies } from "../../platform/pending-replies.js";
import { sessionAmbientEnvironment } from "../session-ambient.js";
import { currentInput, userMessageText } from "../session-prompt.js";
import { SessionTurnFiles } from "../files/session-files.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import {
  AgentSessionCanceledError,
  SessionNotSteerableError,
  registerActiveSessionCancelTarget,
  registerActiveSessionSteerTarget,
} from "../session-control.js";
import type { SessionEventEmitter } from "../session-state.js";
import {
  sessionQuestionsTo,
  claudeQuestionWaitMs,
} from "./claude-questions.js";
import { prepareTurnDirectory } from "./turn-directory.js";

function mcpServers(session: AgentSession) {
  const ambient = sessionAmbientEnvironment(session.id);
  if (!ambient.FOUNDRY_SESSION_TOKEN) return [];
  return [
    {
      name: "foundry",
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../foundry-cli.js", import.meta.url)),
        "mcp",
      ],
      env: Object.entries({ ...ambient, FOUNDRY_SESSION_ID: session.id }).map(
        ([name, value]) => ({ name, value }),
      ),
    },
  ];
}

async function promptBlocks(
  session: AgentSession,
  capabilities: Record<string, boolean> = {},
) {
  const input = currentInput(session);
  const text = userMessageText(
    input.prompt,
    [],
    input.sentBySessionId,
    input.annotations,
  );
  const blocks: Record<string, string>[] = text ? [{ type: "text", text }] : [];
  for (const attachment of input.attachments ?? []) {
    if (attachment.kind === "image") {
      if (!capabilities.image)
        throw new Error(
          "Antigravity does not accept images on this connection.",
        );
      blocks.push({
        type: "image",
        data: (await readFile(attachment.path)).toString("base64"),
        mimeType: attachment.mimeType,
      });
    } else {
      blocks.push({
        type: "resource_link",
        uri: pathToFileURL(attachment.path).href,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
    }
  }
  return blocks;
}

// agy can finish a prompt successfully at the RPC layer while reporting a
// provider failure in its last assistant message.
/** agy meters Gemini models and the other vendors' models (Claude, GPT) as
 * separate allowances, so a quota failure names the one the turn used. */
function quotaPool(model: string | undefined): string {
  if (!model) return "";
  return /gemini/i.test(model) ? "Gemini " : "Claude/GPT ";
}

function terminalFailure(
  text: string,
  profile: string,
  model?: string,
):
  | { reason: string; onlyWarning: boolean; retry?: "auth" | "transient" }
  | undefined {
  const end = text.trimEnd();
  const lineStart = end.lastIndexOf("\n") + 1;
  const native = end.slice(lineStart).trim();
  const onlyWarning = !end.slice(0, lineStart).trim();
  const warning = /^⚠\uFE0F?\s*/.test(native);
  if (
    /^(?:⚠\uFE0F?\s*)?User location is not supported\.?$/i.test(native) ||
    (warning && /User location is not supported/i.test(native))
  )
    return { reason: "Antigravity region: " + native, onlyWarning };
  if (!warning) return;
  const status = /\(code (\d+)\)/i.exec(native);
  const network =
    /\b(?:NETWORK[ _]ERROR|FETCH FAILED|ECONNRESET|ETIMEDOUT|UNAVAILABLE|DEADLINE_EXCEEDED)\b/i.test(
      native,
    );
  if (!status && !network) return;
  const code = Number(status?.[1]);
  if (code === 429 || /\bRESOURCE_EXHAUSTED\b/i.test(native)) {
    const reset =
      /\b(?:resets?|available again|try again)\s+(?:in|at|after)\s+[^()\n]+/i.exec(
        native,
      );
    return {
      reason:
        "Antigravity " +
        quotaPool(model) +
        "quota exhausted for profile " +
        profile +
        (model ? ", model " + model : "") +
        (reset ? " (" + reset[0].trim() + ")" : ""),
      onlyWarning,
    };
  }
  const auth = code === 401 || code === 403;
  const transient = (code >= 500 && code < 600) || network;
  return {
    reason:
      "Antigravity " +
      (auth ? "auth" : transient ? "transient" : "API error") +
      ": " +
      native,
    retry: code === 401 ? "auth" : transient ? "transient" : undefined,
    onlyWarning,
  };
}

export async function runAntigravityWorkspaceSession(
  cwd: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  report: (id: string) => void,
  managedSkills?: ManagedSkillRuntime,
) {
  const input = currentInput(session);
  if (
    session.source !== "chat" ||
    session.role ||
    session.issueId ||
    session.parentSessionId ||
    session.workerGroupId ||
    input.sentBySessionId ||
    input.timerFire ||
    input.channelOrigin ||
    input.executionBudget ||
    (input.inputSource && input.inputSource.kind !== "person")
  )
    throw new Error(
      "Antigravity accepts inputs from the person in their selected Chat.",
    );
  if (input.importedContext)
    throw new Error(
      "Antigravity requires its own native conversation history.",
    );
  if (session.forkNativeSessionId)
    throw new Error("This Antigravity CLI does not advertise session forking.");
  if (profile.command || profile.connectionType !== "local_login")
    throw new Error(
      "Antigravity requires an official device subscription profile.",
    );
  const dir = await prepareTurnDirectory(cwd, session);
  const inputId = input.id;
  const files = SessionTurnFiles.forSession(
    cwd,
    executionSessionsRoot(cwd),
    session,
    emit,
    Date.now(),
  );
  const answers = new PendingReplies<string>();
  const cancel = new AbortController();
  let nativeId = session.nativeSessionId ?? "";
  let prompting = false;
  let cancelDeadline: ReturnType<typeof setTimeout> | undefined;
  let response = "";
  const tools = new Map<string, TranscriptMessage>();
  let streamKind = "";
  let streamText = "";
  let streamId = "";
  const release = await acquireRuntime("antigravity");
  let client: AcpClient | undefined;
  let stopCancel = () => {};
  let stopSteer = () => {};
  try {
    requireAntigravityLogin(profileID(profile));
    if (managedSkills) linkCodexSkills(managedSkills, cwd);
    const invocation = antigravityInvocation(profileID(profile));
    let hadActivity = false;
    let terminalText = "";
    const connect = () =>
      new AcpClient(invocation, cwd, {
        acceptUpdate: () => prompting,
        async update({ sessionId, update }) {
          if (!prompting || sessionId !== nativeId) return;
          const kind = update.sessionUpdate;
          if (
            kind === "agent_message_chunk" ||
            kind === "agent_thought_chunk"
          ) {
            if (update.content?.type !== "text") {
              hadActivity = true;
              return;
            }
            if (
              kind === "agent_thought_chunk" &&
              (response || update.content.text)
            )
              hadActivity = true;
            if (streamKind !== kind) {
              streamKind = kind;
              streamText = "";
              streamId = randomUUID();
            }
            streamText += update.content.text;
            if (kind === "agent_message_chunk") {
              // A native warning may start a separate message with no newline.
              if (
                /^\s*(?:⚠|User location is not supported)/i.test(
                  update.content.text,
                )
              ) {
                if (terminalText.trim()) hadActivity = true;
                terminalText = "";
              }
              terminalText += update.content.text;
              response = streamText;
            }
            await emit(
              sessionEventLabels.responseStream,
              streamText,
              undefined,
              undefined,
              {
                id: streamId,
                text: streamText,
                kind:
                  kind === "agent_message_chunk" ? "assistant" : "reasoning",
              },
            );
          } else if (kind === "tool_call" || kind === "tool_call_update") {
            hadActivity = true;
            streamKind = "";
            const status =
              update.status === "completed" || update.status === "failed"
                ? update.status
                : "running";
            const previous = tools.get(update.toolCallId);
            const text = update.content
              ?.flatMap((part: { content?: { text?: string } }) =>
                part.content?.text ? [part.content.text] : [],
              )
              .join("\n");
            const message: TranscriptMessage = {
              id: update.toolCallId,
              callId: update.toolCallId,
              kind: "tool",
              status,
              title: update.title ?? previous?.title,
              text: text || previous?.text || update.title || "",
            };
            tools.set(update.toolCallId, message);
            await emit(
              "Antigravity tool",
              message.title ?? "",
              undefined,
              undefined,
              message,
            );
          } else if (kind === "plan") {
            hadActivity = true;
          } else if (kind === "usage_update") {
            await emit("Context usage", "", undefined, {
              contextUsage: {
                inputTokens: update.used,
                contextWindow: update.size,
              },
            });
          }
        },
        async permission({ sessionId, options, toolCall }) {
          const cancelled = { outcome: { outcome: "cancelled" } };
          if (
            !prompting ||
            cancel.signal.aborted ||
            sessionId !== nativeId ||
            sessionQuestionsTo(session) !== "person"
          )
            return cancelled;
          hadActivity = true;
          const id = randomUUID();
          const detail = toolCall.rawInput
            ? JSON.stringify(toolCall.rawInput, null, 2).slice(0, 4000)
            : undefined;
          const message: TranscriptMessage = {
            id,
            kind: "assistant",
            text: toolCall.title,
            questions: [
              {
                title: toolCall.title,
                detail,
                unranked: true,
                options: options.map((item: { name: string }) => item.name),
              },
            ],
          };
          const wait = answers
            .wait<string>(id, {
              signal: cancel.signal,
              timeout: {
                ms: claudeQuestionWaitMs(),
                error: () => new Error("Permission request expired."),
              },
            })
            .catch(() => "");
          try {
            await emit(
              sessionEventLabels.responseStream,
              message.text,
              undefined,
              undefined,
              message,
            );
            const answer = await wait;
            const matches = options.filter(
              (item: { name: string }) => item.name === answer,
            );
            return matches.length === 1
              ? {
                  outcome: {
                    outcome: "selected",
                    optionId: matches[0].optionId,
                  },
                }
              : cancelled;
          } finally {
            answers.reject(id, new Error("Permission request closed."));
            await emit(sessionEventLabels.questionSettled, id, "info");
          }
        },
      });
    let acp = (client = connect());
    stopCancel = registerActiveSessionCancelTarget(session.id, {
      provider: session.provider,
      inputId,
      cancel() {
        cancel.abort();
        if (!prompting) return acp.close();
        acp.notify("session/cancel", { sessionId: nativeId });
        cancelDeadline = setTimeout(() => acp.close(), 1500);
        cancelDeadline.unref();
      },
    });
    stopSteer = registerActiveSessionSteerTarget(session.id, {
      provider: session.provider,
      async steer(text, _attachments, _id, sender) {
        if (!sender)
          for (const reply of parseAgentQuestionReply(text) ?? [])
            if (
              answers.resolve(reply.itemId, reply.noAnswer ? "" : reply.answer)
            )
              return;
        throw new SessionNotSteerableError();
      },
    });
    await emitSetup();
    const retries = { auth: 0, transient: 0 };
    let prompt: Awaited<ReturnType<typeof promptBlocks>> | undefined;
    for (;;) {
      const { agentCapabilities } = await acp.initialize();
      const setup = { cwd, mcpServers: mcpServers(session) };
      const opened = nativeId
        ? await acp.request(
            agentCapabilities.sessionCapabilities?.resume
              ? "session/resume"
              : "session/load",
            { ...setup, sessionId: nativeId },
          )
        : await acp.request("session/new", setup);
      nativeId ||= opened.sessionId;
      if (!nativeId)
        throw new Error("Antigravity returned no native session id.");
      if (!prompt) report(nativeId);
      let options = opened.configOptions ?? [];
      for (const [category, value] of [
        ["model", session.model || profile.model],
        [
          "thought_level",
          session.antigravityEffort || profile.antigravityEffort,
        ],
      ]) {
        if (!value) continue;
        const option = options.find(
          (o: { category?: string; id: string }) =>
            (o.category ?? o.id) === category,
        );
        if (
          !option &&
          category === "model" &&
          opened.models?.availableModels?.some(
            (model: { modelId: string }) => model.modelId === value,
          )
        ) {
          if (opened.models.currentModelId !== value)
            await acp.request("session/set_model", {
              sessionId: nativeId,
              modelId: value,
            });
          continue;
        }
        if (!option)
          throw new Error(
            `Antigravity did not advertise a ${category} option.`,
          );
        if (option.currentValue !== value) {
          const changed = await acp.request("session/set_config_option", {
            sessionId: nativeId,
            configId: option.id,
            value,
          });
          options = changed.configOptions ?? options;
        }
      }
      if (!prompt) await files.snapshotWorkTree();
      prompt ??= await promptBlocks(
        session,
        agentCapabilities.promptCapabilities,
      );
      prompting = true;
      const result = await acp.request("session/prompt", {
        sessionId: nativeId,
        prompt,
      });
      prompting = false;
      if (cancel.signal.aborted || result.stopReason === "cancelled")
        throw new AgentSessionCanceledError();
      const failure = terminalFailure(
        terminalText,
        profile.label || profileID(profile),
        session.model || profile.model,
      );
      if (!failure) break;
      const retry = failure.retry;
      if (
        !retry ||
        !failure.onlyWarning ||
        hadActivity ||
        !agentCapabilities.sessionCapabilities?.resume ||
        retries[retry] >= (retry === "auth" ? 1 : 2)
      )
        throw new Error(failure.reason);
      retries[retry]++;
      await delay(3500, undefined, { signal: cancel.signal });
      acp.close();
      acp = client = connect();
      streamKind = "";
      response = "";
      terminalText = "";
    }
    const path = join(dir, "result.md");
    await writeFile(path, response + "\n");
    const fileReferences = await files.finish(response);
    await emit(sessionEventLabels.antigravityTurnEnd, path, undefined, {
      fileReferences,
    });
    return { nativeSessionId: nativeId, response };
  } catch (error) {
    if (cancel.signal.aborted) throw new AgentSessionCanceledError();
    throw error;
  } finally {
    clearTimeout(cancelDeadline);
    stopCancel();
    stopSteer();
    cancel.abort();
    client?.close();
    release();
  }
}
