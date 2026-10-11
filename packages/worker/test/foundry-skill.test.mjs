import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  foundryCommands,
  isToolCommand,
} from "../dist/foundry-cli-commands.js";

// The skills Foundry delivers may name only Foundry tools that exist, with
// arguments they take: an agent acts on what a skill says. They teach the
// tools, not the `foundry` CLI, which is a client of the same tools for
// people at a shell.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(packageDir, "skills");
const serverDir = resolve(packageDir, "../../apps/server/internal");
const tools = new Map(
  JSON.parse(
    readFileSync(resolve(serverDir, "httpapi/mcp_tools.json"), "utf8"),
  ).map((tool) => [tool.name, tool]),
);

// Words in code that look like tool names but name something else.
const notTools = new Set(["run_in_background"]);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

// The server delivers the skill to every dispatched session from its own
// copy (builtinskills); `foundry skill install` writes the worker's. One
// skill: the two folders hold the same files with the same bytes.
test("the server's built-in foundry skill is the worker's bundled one", () => {
  const relativeFiles = (root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)))
      .sort();
  const bundled = join(skillsRoot, "foundry");
  const builtin = join(serverDir, "builtinskills/foundry");
  assert.deepEqual(relativeFiles(builtin), relativeFiles(bundled));
  for (const file of relativeFiles(bundled))
    assert.equal(
      readFileSync(join(builtin, file), "utf8"),
      readFileSync(join(bundled, file), "utf8"),
      `${file} differs between the server's and the worker's copy`,
    );
});

/** Every inline code span of every bundled skill file. */
function codeSpans() {
  return markdownFiles(skillsRoot).flatMap((path) => {
    const file = relative(skillsRoot, path);
    const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "");
    return [...text.matchAll(/`([^`]+)`/g)].map((match) => ({
      file,
      span: match[1].replace(/\s+/g, " ").trim(),
    }));
  });
}

test("the skill names only Foundry tools that exist, called with arguments they take", () => {
  const named = new Set();
  for (const { file, span } of codeSpans()) {
    for (const [word] of span.matchAll(/\b[a-z]+(?:_[a-z]+)+\b(?!_)/g)) {
      if (notTools.has(word)) continue;
      assert.ok(tools.has(word), `${file}: \`${span}\` names no tool ${word}`);
      named.add(word);
    }
    const call = span.match(/^([a-z_]+) (\{.*\})$/);
    if (!call) continue;
    const properties = tools.get(call[1]).inputSchema.properties;
    for (const [argument, value] of Object.entries(JSON.parse(call[2]))) {
      assert.ok(
        Object.hasOwn(properties, argument),
        `${file}: \`${span}\`: ${call[1]} takes no ${argument}`,
      );
      const allowed = properties[argument].enum;
      assert.ok(
        !allowed || allowed.includes(value),
        `${file}: \`${span}\`: ${argument} is one of ${allowed}`,
      );
    }
  }
  assert.deepEqual(
    [...tools.keys()].filter((name) => !named.has(name)),
    [],
    "the skill teaches every Foundry tool",
  );
});

test("the skill teaches the MCP tools, not the CLI", () => {
  const commands = codeSpans().filter(({ span }) =>
    span.startsWith("foundry "),
  );
  assert.deepEqual(
    commands.map(({ file, span }) => `${file}: ${span}`),
    [],
    "a session calls the MCP tools; the CLI is for people",
  );
});

// One implementation: every CLI command calls one Foundry tool with
// arguments the tool takes, and every tool but the Issue execution's own
// has a command.
test("every CLI command calls a Foundry tool with arguments it takes", () => {
  const commanded = new Set();
  for (const [command, verbs] of Object.entries(foundryCommands)) {
    for (const [verb, spec] of Object.entries(verbs)) {
      if (!isToolCommand(spec)) continue;
      const name = `foundry ${command} ${verb}`;
      const tool = tools.get(spec.tool);
      assert.ok(tool, `${name} calls no tool ${spec.tool}`);
      commanded.add(spec.tool);
      const properties = tool.inputSchema.properties;
      const takes = (argument, what) =>
        assert.ok(
          Object.hasOwn(properties, argument),
          `${name}: ${what} sets ${argument}, which ${spec.tool} does not take`,
        );
      if (spec.positional) takes(spec.positional, "its word");
      for (const [argument, value] of Object.entries(spec.fixed ?? {})) {
        takes(argument, "it always");
        const allowed = properties[argument].enum;
        assert.ok(!allowed || allowed.includes(value), `${name}: ${value}`);
      }
      for (const [flag, { argument }] of Object.entries(spec.flags))
        takes(argument, flag);
      for (const required of tool.inputSchema.required ?? [])
        assert.ok(
          spec.positional === required ||
            Object.values(spec.flags).some((f) => f.argument === required),
          `${name} cannot set ${required}, which ${spec.tool} requires`,
        );
    }
  }
  assert.deepEqual(
    [...tools.keys()].filter(
      (name) => !commanded.has(name) && name !== "ask_person",
    ),
    [],
    "every tool has a command",
  );
});

test("the CLI dispatches by the command table", () => {
  const cli = readFileSync(join(packageDir, "dist", "foundry-cli.js"), "utf8");
  assert.ok(cli.includes("foundryCommands[command]"));
  assert.doesNotMatch(
    cli,
    /\/api\/(?!mcp)/,
    "the CLI reaches the server only through /api/mcp",
  );
  const client = readFileSync(
    join(packageDir, "dist", "foundry-client.js"),
    "utf8",
  );
  assert.deepEqual(
    [
      ...new Set(
        [...client.matchAll(/["'`](\/api\/[a-z-/]*)/g)].map(
          (match) => match[1],
        ),
      ),
    ],
    ["/api/mcp"],
    "the client calls no REST endpoint",
  );
});
