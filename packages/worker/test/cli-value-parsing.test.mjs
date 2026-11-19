import assert from "node:assert/strict";
import test from "node:test";
import {
  cliCommands,
  parseCliInvocation,
} from "../dist/daemon/cli-contract.js";

function parseError(args) {
  try {
    parseCliInvocation(args);
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${args.join(" ")} to fail`);
}

function requiredPlaceholders(command) {
  return (command.arguments ?? [])
    .filter((argument) => argument.required)
    .map(() => "value");
}

test("a separate value that begins with a dash is the flag's value", () => {
  const parsed = parseCliInvocation(["setup", "--token", "-abc"]);
  assert.equal(parsed.command.id, "setup");
  assert.deepEqual(parsed.positionals, []);
});

test("--flag=-value parses like the separate form", () => {
  const parsed = parseCliInvocation(["setup", "--token=-abc"]);
  assert.equal(parsed.command.id, "setup");
  assert.deepEqual(parsed.positionals, []);
});

test("a dash value is consumed, not left as a positional", () => {
  const parsed = parseCliInvocation([
    "proxy",
    "set",
    "--no-proxy",
    "-abc",
    "http://proxy.example:8080",
  ]);
  assert.deepEqual(parsed.positionals, ["http://proxy.example:8080"]);
});

test("the separate and inline forms both hand the dash value to validation", () => {
  for (const args of [
    ["logs", "--lines", "-5"],
    ["logs", "--lines=-5"],
  ]) {
    const error = parseError(args);
    assert.equal(error.code, "E1004", args.join(" "));
    assert.equal(error.trigger, "--lines=-5", args.join(" "));
  }
});

test("a value-taking flag at the end of the arguments is E1002 MISSING_VALUE", () => {
  for (const args of [
    ["setup", "--token"],
    ["setup", "--workspace", ".", "--token"],
  ]) {
    const error = parseError(args);
    assert.equal(error.code, "E1002", args.join(" "));
    assert.equal(error.errorName, "MISSING_VALUE", args.join(" "));
    assert.equal(error.trigger, "--token", args.join(" "));
  }
});

test("an empty inline value is still rejected as an invalid string", () => {
  const error = parseError(["setup", "--token="]);
  assert.equal(error.code, "E1004");
  assert.equal(error.errorName, "INVALID_VALUE");
});

test("a value-taking flag followed by a flag this command accepts is E1002", () => {
  for (const args of [
    ["setup", "--token", "--no-service"],
    ["setup", "--token", "--token=abc"],
    ["setup", "--server", "--workspace", "."],
    ["setup", "--token", "--"],
  ]) {
    const error = parseError(args);
    assert.equal(error.code, "E1002", args.join(" "));
    assert.equal(error.errorName, "MISSING_VALUE", args.join(" "));
  }
});

test("a dash-prefixed value that is not a flag of this command is taken as the value", () => {
  // Base64url pairing tokens can begin with "--"; only known flags stop a value.
  assert.doesNotThrow(() => parseCliInvocation(["setup", "--token", "--abc"]));
});

test("a bool flag takes no value, so a following dash argument is an unknown option", () => {
  const error = parseError(["setup", "--no-service", "-abc"]);
  assert.equal(error.code, "E1003");
  assert.equal(error.errorName, "UNKNOWN_OPTION");
});

test("a bool flag with an inline value is still rejected", () => {
  const error = parseError(["setup", "--no-service=yes"]);
  assert.equal(error.code, "E1004");
});

test("every value-taking flag takes a dash-prefixed value, separate or inline", () => {
  for (const command of cliCommands) {
    const placeholders = requiredPlaceholders(command);
    for (const option of command.options ?? []) {
      if (option.type === "bool") continue;
      for (const flagArgs of [[option.name, "-x"], [`${option.name}=-x`]]) {
        const args = [...command.path, ...placeholders, ...flagArgs];
        let error;
        try {
          parseCliInvocation(args);
        } catch (caught) {
          error = caught;
        }
        // "-x" is either accepted or refused as an invalid value; it is never
        // reported as a missing value or an unknown option.
        if (error !== undefined) {
          assert.equal(error.errorName, "INVALID_VALUE", args.join(" "));
        }
      }
    }
  }
});

test("every value-taking flag at the end of the arguments is E1002 MISSING_VALUE", () => {
  for (const command of cliCommands) {
    const placeholders = requiredPlaceholders(command);
    for (const option of command.options ?? []) {
      if (option.type === "bool") continue;
      const args = [...command.path, ...placeholders, option.name];
      const error = parseError(args);
      assert.equal(error.errorName, "MISSING_VALUE", args.join(" "));
    }
  }
});

test("every value-taking flag refuses a flag the same command accepts as its value", () => {
  for (const command of cliCommands) {
    const options = command.options ?? [];
    if (options.length === 0) continue;
    const placeholders = requiredPlaceholders(command);
    for (const option of options) {
      if (option.type === "bool") continue;
      const args = [
        ...command.path,
        ...placeholders,
        option.name,
        options[0].name,
      ];
      const error = parseError(args);
      assert.equal(error.errorName, "MISSING_VALUE", args.join(" "));
    }
  }
});
