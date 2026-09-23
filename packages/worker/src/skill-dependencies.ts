/** Device-wide indexed analysis. File contents are never executed. */
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import type { SkillDependency } from "@foundry/protocol";
import type { ZipEntry } from "./skill-zip.js";
export interface KnownSkill {
  name: string;
  dir: string;
  root: string;
  dirName: string;
  logicalDir?: string;
}
const TEXT =
  /\.(md|markdown|mdx|txt|rst|sh|bash|zsh|js|jsx|cjs|mjs|ts|tsx|mts|py|yaml|yml|json|toml|html|xml|sql)$/i;
const inside = (path: string, dir: string) =>
  path === dir || path.startsWith(dir + sep);
interface Signal {
  name: string;
  strength: "required" | "related";
  evidence: string;
  candidates?: KnownSkill[];
}

/** Build name/path indexes once; parse each physical tree once, even if it is
 * installed through symlinks in several runtimes. Resolution retains root identity. */
export function createSkillDependencyAnalyzer(known: KnownSkill[]) {
  const byName = new Map<string, KnownSkill[]>();
  const byDir = new Map<string, KnownSkill[]>();
  const parsed = new Map<string, Signal[]>();
  for (const skill of known) {
    for (const name of new Set([skill.name, skill.dirName]))
      byName.set(name, [...(byName.get(name) ?? []), skill]);
    for (const dir of new Set([skill.dir, skill.logicalDir ?? skill.dir]))
      byDir.set(dir, [...(byDir.get(dir) ?? []), skill]);
  }
  function owners(path: string): KnownSkill[] | undefined {
    // O(path depth) lookup, not a scan of every installed skill.
    let at = path;
    while (true) {
      if (byDir.has(at)) return byDir.get(at);
      const parent = dirname(at);
      if (parent === at) return undefined;
      at = parent;
    }
  }
  function parse(self: KnownSkill, entries: ZipEntry[]): Signal[] {
    const signals: Signal[] = [];
    for (const file of entries) {
      if (!TEXT.test(file.path) && file.path.split("/").pop()!.includes("."))
        continue;
      if (file.data.includes(0)) continue;
      const lines = file.data.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Avoid materializing evidence strings on lines without an actual signal.
        const evidence = () =>
          `${file.path}:${i + 1}: ${line.trim().slice(0, 200)}`;
        const add = (
          name: string,
          strength: Signal["strength"],
          candidates?: KnownSkill[],
        ) => signals.push({ name, strength, evidence: evidence(), candidates });
        for (const match of line.matchAll(
          /(?:^|[\s`"'(=])((?:https?:\/\/[^\s)`"']+|(?:~|\$HOME|\$\{HOME\})?\/[\w./-]+|\.{1,2}\/[\w./-]+|(?:\.agents|\.claude|\.codex|references|scripts|assets)\/[\w./-]+))/g,
        )) {
          const raw = match[1]!;
          // An installation directory or an explicitly optional fallback is
          // a reference, not proof that executing this skill needs that peer.
          const optional =
            /\b(?:optional|fallback|alternative)\b|备选|可选|如果.*(?:不可用|不在)/i.test(
              line,
            );
          const fileReference =
            /\/(?:SKILL\.md|[^/]+\.[A-Za-z0-9]+)$/.test(raw) ||
            /\/(?:scripts|references|assets)\//.test(raw);
          const pathStrength =
            optional || !fileReference ? "related" : "required";
          if (/^https?:/.test(raw)) continue;
          const homePrefix = /^(?:~|\$HOME|\$\{HOME\})\//;
          const path = homePrefix.test(raw)
            ? resolve(homedir(), raw.replace(homePrefix, ""))
            : resolve(self.dir, dirname(file.path), raw);
          if (inside(path, self.dir)) continue;
          const matches = owners(path);
          if (matches) add(matches[0]!.name, pathStrength, matches);
          else {
            const named = /(?:^|\/)skills\/([\w-]+)(?:\/|$)/.exec(raw)?.[1];
            const sibling = /^(?:\.\.\/)+([\w-]+)(?:\/|$)/.exec(raw)?.[1];
            const siblingSkill =
              sibling &&
              (/\/SKILL\.md$/.test(raw) ||
                /^(?:\.\.\/)+[\w-]+\/(?:references|scripts|assets)\//.test(
                  raw,
                ) ||
                byName.has(sibling));
            if (named || siblingSkill) add(named ?? sibling!, pathStrength);
          }
        }
        for (const m of line.matchAll(
          /\bSkill\s*\(\s*(?:(?:skill|name)\s*[:=]\s*)?["'`]([\w-]+)["'`]/g,
        ))
          add(m[1]!, "required");
        for (const m of line.matchAll(/\b"skill"\s*:\s*"([\w-]+)"/g))
          add(m[1]!, "related");
        if (!/skill|技能|交给|委派|delegate|hand.off/i.test(line)) continue;
        const withoutPaths = line
          .replace(/\[[^\]]*\]\([^)]*\)/g, "")
          .replace(/(?:[\w.~$-]+\/)+[\w./-]+/g, "");
        // Tokenize once; membership is constant time. No per-line N-regex loop.
        for (const token of new Set(
          withoutPaths.match(/[A-Za-z0-9_-]+/g) ?? [],
        ))
          if (byName.has(token)) add(token, "related");
        for (const m of withoutPaths.matchAll(
          /(?:use|invoke|load|调用|使用|加载)\s+(?:the\s+)?(?:skill|技能)\s+[`"']?([\w-]+)/gi,
        ))
          add(m[1]!, "related");
      }
    }
    return signals;
  }
  return (self: KnownSkill, entries: ZipEntry[]): SkillDependency[] => {
    let signals = parsed.get(self.dir);
    if (!signals) {
      signals = parse(self, entries);
      parsed.set(self.dir, signals);
    }
    const edges = new Map<string, SkillDependency>();
    for (const signal of signals) {
      if (signal.name === self.name) continue;
      let matches = signal.candidates ?? byName.get(signal.name) ?? [];
      const sameRoot = matches.filter((s) => s.root === self.root);
      if (sameRoot.length) matches = sameRoot;
      matches = [...new Map(matches.map((s) => [s.dir, s])).values()];
      const target = matches.length === 1 ? matches[0] : undefined;
      const dep: SkillDependency = {
        skillName: target?.name ?? signal.name,
        strength: signal.strength,
        evidence: signal.evidence,
        status: target ? "resolved" : matches.length ? "ambiguous" : "missing",
        ...(target
          ? { targetRoot: target.root, targetDirName: target.dirName }
          : {}),
      };
      const key = `${dep.skillName}:${dep.targetRoot ?? ""}:${dep.targetDirName ?? ""}`;
      if (edges.get(key)?.strength !== "required") edges.set(key, dep);
    }
    return [...edges.values()].sort((a, b) =>
      a.skillName.localeCompare(b.skillName),
    );
  };
}
