// Whether a newer build of the web app was deployed than the one this page
// runs. A page keeps its bundle until it reloads, so a tab left open across
// a deploy would run old code (and keep its own stream) indefinitely. The
// deployment names its build in version.json (see lib/web-build.ts); the
// tabs of a browser share what one of them read, so one check serves all.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NoticeLine } from "../components/ui/app-shell";
import { Button } from "../components/ui/button";
import { fetchDeployedBuild, runningBuild } from "../lib/web-build";
import { foundryStream } from "../stream/foundry-stream";
import type { Tabs } from "../stream/tabs";

/** How often a browser asks which build is deployed. */
export const deployedBuildCheckMs = 10 * 60_000;

/** A check this recent is not repeated when the stream reopens or a tab shows. */
export const deployedBuildFreshMs = 60_000;

/**
 * A tab hidden this long reloads into the newer build by itself, when it
 * holds nothing the reload would lose (see pageHoldsWork).
 */
export const hiddenReloadAfterMs = 5 * 60_000;

export interface DeployedBuildWatchEnvironment {
  /** The build this page runs. */
  running: string;
  /** Which build is deployed; undefined when that is not known. */
  fetchDeployed: () => Promise<string | undefined>;
  /** The other tabs; undefined where tabs cannot coordinate. */
  tabs: Tabs | undefined;
  now?: () => number;
}

export type DeployedBuildWatch = ReturnType<typeof createDeployedBuildWatch>;

/** Follows which build is deployed, as this tab or another one read it. */
export function createDeployedBuildWatch(
  environment: DeployedBuildWatchEnvironment,
) {
  const now = environment.now ?? Date.now;
  const tabs = environment.tabs;
  const listeners = new Set<() => void>();
  let deployed: string | undefined;
  /** When a tab last read it; the page loading counts: it got the deployed one. */
  let heardAt = now();
  let reading: Promise<void> | undefined;

  function learn(build: string, at: number): void {
    heardAt = Math.max(heardAt, at);
    if (build === deployed) return;
    deployed = build;
    for (const listener of [...listeners]) listener();
  }

  const stopListening = tabs?.listen((message) => {
    if (message.kind === "build") learn(message.build, message.at);
  });

  function read(): Promise<void> {
    reading ??= environment
      .fetchDeployed()
      .then((build) => {
        if (!build) return;
        const at = now();
        learn(build, at);
        tabs?.post({ kind: "build", build, at });
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  }

  /** Reads it unless some tab did within `maxAgeMs`. */
  function readIfOlder(maxAgeMs: number): Promise<void> | undefined {
    return now() - heardAt < maxAgeMs ? undefined : read();
  }

  /** This tab reads for the browser: it keeps the stream, or no tab does. */
  function readsForBrowser(): boolean {
    return !tabs || tabs.leading() || !tabs.leaderElsewhere();
  }

  return {
    /** A build other than this page's is deployed. */
    newer: (): boolean =>
      deployed !== undefined && deployed !== environment.running,
    deployed: (): string | undefined => deployed,
    /** Runs `listener` when the deployed build changes; returns the unsubscribe. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Every deployedBuildCheckMs. Another tab's leader may be an older build
     * that reads nothing: a tab that heard nothing for two periods reads.
     */
    tick: (): Promise<void> | undefined =>
      readIfOlder(
        readsForBrowser() ? deployedBuildCheckMs / 2 : deployedBuildCheckMs * 2,
      ),
    /** The stream (re)opened: a deploy restarts the server. */
    streamOpened: (): Promise<void> | undefined =>
      readsForBrowser() ? readIfOlder(deployedBuildFreshMs) : undefined,
    /** The tab shows again, maybe after long. */
    shown: (): Promise<void> | undefined => readIfOlder(deployedBuildFreshMs),
    dispose(): void {
      stopListening?.();
      listeners.clear();
    },
  };
}

const textEntryInputs =
  'input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="number"], input[type="password"], input[type="tel"]';

/**
 * Whether the page holds something a reload could lose: text typed into a
 * field, or an open dialog. Any text counts, even what a form loaded:
 * whether it was edited cannot be told.
 */
export function pageHoldsWork(root: ParentNode): boolean {
  if (root.querySelector('[role="dialog"], [role="alertdialog"]')) return true;
  for (const field of root.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >(`textarea, ${textEntryInputs}`))
    if (field.value.trim()) return true;
  for (const editable of root.querySelectorAll('[contenteditable="true"]'))
    if (editable.textContent?.trim()) return true;
  return false;
}

/** Where a tab notes the build it reloaded for, to try that once only. */
const reloadedForKey = "foundry.reloadedForBuild";

/**
 * Whether a newer build is deployed than this page runs. A tab hidden for
 * hiddenReloadAfterMs reloads into it by itself when that loses nothing:
 * nobody is looking or typing there. Once per build: should the reload still
 * get the old one (a cache in between), the tab only offers the reload.
 */
export function useNewBuildAvailable(): boolean {
  const [newer, setNewer] = useState(false);

  useEffect(() => {
    const running = runningBuild();
    // The Vite dev server: not a build, nothing to compare.
    if (!running) return;
    const watch = createDeployedBuildWatch({
      running,
      fetchDeployed: () => fetchDeployedBuild(),
      tabs: foundryStream.tabs(),
    });
    let hiddenSince = document.hidden ? Date.now() : undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;

    const reloadIfUnattended = () => {
      const build = watch.deployed();
      if (!watch.newer() || !build || hiddenSince === undefined) return;
      if (Date.now() - hiddenSince < hiddenReloadAfterMs) return;
      if (pageHoldsWork(document)) return;
      if (sessionStorage.getItem(reloadedForKey) === build) return;
      sessionStorage.setItem(reloadedForKey, build);
      location.reload();
    };
    const waitHidden = () => {
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(reloadIfUnattended, hiddenReloadAfterMs);
    };
    if (hiddenSince !== undefined) waitHidden();

    const stopWatching = watch.subscribe(() => {
      setNewer(watch.newer());
      reloadIfUnattended();
    });
    const stopStream = foundryStream.onStreamLifecycle({
      onOpen: () => void watch.streamOpened(),
    });
    const onVisibility = () => {
      if (document.hidden) {
        hiddenSince = Date.now();
        waitHidden();
        return;
      }
      hiddenSince = undefined;
      clearTimeout(hiddenTimer);
      void watch.shown();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const interval = setInterval(() => {
      void Promise.resolve(watch.tick()).then(reloadIfUnattended);
    }, deployedBuildCheckMs);

    return () => {
      clearInterval(interval);
      clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      stopStream();
      stopWatching();
      watch.dispose();
    };
  }, []);

  return newer;
}

/** "A new version is available — Reload", while one is. */
export function NewBuildNotice() {
  const { t } = useTranslation("shell");
  if (!useNewBuildAvailable()) return null;
  return (
    <NoticeLine
      action={
        <Button onClick={() => location.reload()} size="inline" variant="link">
          {t("notices.reloadNewVersion")}
        </Button>
      }
    >
      {t("notices.newVersion")}
    </NoticeLine>
  );
}
