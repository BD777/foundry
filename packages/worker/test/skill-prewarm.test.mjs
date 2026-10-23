import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { SkillPrewarmer } from "../dist/skill-prewarm.js";
import {
  prepareSkillContent,
  skillContentDigest,
} from "../dist/skill-content-cache.js";
import { foundryStatePath } from "../dist/state-root.js";
import { packZip } from "../dist/skill-zip.js";

function fixture() {
  const name = `warm-${randomUUID()}`;
  const files = [
    { path: "SKILL.md", data: Buffer.from(`---\nname: ${name}\n---\nMethod`) },
  ];
  const zip = packZip(files);
  return {
    zip,
    ref: {
      skillId: name,
      name,
      revision: 1,
      checksum: createHash("sha256").update(zip).digest("hex"),
      byteSize: zip.length,
      sourceDigest: skillContentDigest(files),
    },
  };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Preparation did not settle");
    await delay(10);
  }
}

test(
  "background preparation is latest-only, duplicate updates coalesce, disconnect cancels",
  { timeout: 15000 },
  async (t) => {
    const old = fixture(),
      next = fixture(),
      stopped = fixture();
    const calls = [],
      closed = new Set(),
      errors = [];
    const server = createServer((request, response) => {
      const id = request.url.split("/")[4];
      calls.push(id);
      response.once("close", () => closed.add(id));
      if (id === next.ref.skillId) response.end(next.zip);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const warmer = new SkillPrewarmer((message) => errors.push(message));
    t.after(() => {
      warmer.stop();
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    warmer.update([old.ref], url);
    await until(() => calls.includes(old.ref.skillId));
    warmer.update([next.ref], url);
    warmer.update([next.ref], url);
    await until(() =>
      existsSync(foundryStatePath("skill-content", `${next.ref.checksum}.bin`)),
    );
    assert.ok(
      closed.has(old.ref.skillId),
      "superseded work canceled before new preparation",
    );
    assert.equal(calls.filter((id) => id === next.ref.skillId).length, 1);
    assert.equal(
      (await prepareSkillContent("http://127.0.0.1:1", next.ref)).source,
      "expanded-cache",
    );
    warmer.update([stopped.ref], url);
    await until(() => calls.includes(stopped.ref.skillId));
    warmer.stop();
    await until(() => closed.has(stopped.ref.skillId));
    assert.equal(
      existsSync(
        foundryStatePath("skill-content", `${stopped.ref.checksum}.bin`),
      ),
      false,
    );
    assert.deepEqual(errors, []);
  },
);
