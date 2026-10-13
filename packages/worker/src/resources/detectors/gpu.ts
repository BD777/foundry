// GPUs: NVIDIA ones through nvidia-smi (Linux, Windows), other PCI display
// controllers through lspci (Linux), and the Mac's through system_profiler.

import type { DetectContext, DetectedInstance, Detector } from "../detector.js";
import { findOnPath } from "../exec.js";

const listed = { ready: true, level: "installed" } as const;

async function nvidiaGpus(
  context: DetectContext,
  nvidiaSmi: string,
): Promise<DetectedInstance[]> {
  const run = await context.exec(
    nvidiaSmi,
    [
      "--query-gpu=index,name,memory.total,driver_version,uuid",
      "--format=csv,noheader,nounits",
    ],
    { timeoutMs: 5000 },
  );
  if (run.code !== 0)
    return [
      {
        key: "gpu/nvidia",
        type: "gpu",
        platform: context.platform === "win32" ? "windows" : "linux",
        name: "NVIDIA GPU",
        readiness: {
          ready: false,
          level: "installed",
          reason: `nvidia-smi failed: ${run.stderr.trim().split("\n")[0] || `exit ${run.code}`}`,
        },
      },
    ];
  return run.stdout
    .split(/\r?\n/)
    .map((line) => line.split(",").map((field) => field.trim()))
    .filter((fields) => fields.length >= 5 && fields[4])
    .map(([index, name, memory, driver, uuid]) => ({
      key: `gpu/nvidia/${uuid}`,
      type: "gpu" as const,
      platform: context.platform === "win32" ? "windows" : "linux",
      name: name!,
      readiness: listed,
      backends: [
        { id: "nvidia-smi", mode: "listed" as const, readiness: listed },
      ],
      details: {
        vendor: "NVIDIA",
        index: index!,
        memoryMiB: memory!,
        driver: driver!,
      },
    }));
}

async function pciGpus(
  context: DetectContext,
  lspci: string,
): Promise<DetectedInstance[]> {
  const run = await context.exec(lspci, [], { timeoutMs: 3000 });
  if (run.code !== 0)
    throw new Error(`lspci failed: ${run.stderr.trim() || `exit ${run.code}`}`);
  return run.stdout
    .split("\n")
    .map((line) =>
      /^(\S+)\s+(VGA compatible controller|3D controller|Display controller):\s*(.+)$/.exec(
        line.trim(),
      ),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, slot, kind, description]) => ({
      key: `gpu/pci/${slot}`,
      type: "gpu" as const,
      platform: "linux" as const,
      name: description!,
      readiness: listed,
      details: { slot: slot!, class: kind! },
    }));
}

interface MacDisplay {
  _name?: string;
  sppci_model?: string;
  sppci_cores?: string;
  sppci_vendor?: string;
  spdisplays_vram?: string;
  spdisplays_mtlgpufamilysupport?: string;
}

async function macGpus(context: DetectContext): Promise<DetectedInstance[]> {
  const run = await context.exec(
    "/usr/sbin/system_profiler",
    ["SPDisplaysDataType", "-json"],
    { timeoutMs: 8000 },
  );
  if (run.code !== 0)
    throw new Error(
      `system_profiler failed: ${run.stderr.trim() || `exit ${run.code}`}`,
    );
  const displays =
    (JSON.parse(run.stdout) as { SPDisplaysDataType?: MacDisplay[] })
      .SPDisplaysDataType ?? [];
  return displays.map((display, index) => {
    const name = display.sppci_model ?? display._name ?? `GPU ${index}`;
    const details = Object.fromEntries(
      Object.entries({
        cores: display.sppci_cores,
        vram: display.spdisplays_vram,
        metal: display.spdisplays_mtlgpufamilysupport?.replace(
          /^spdisplays_/,
          "",
        ),
      }).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    return {
      key: `gpu/macos/${index}`,
      type: "gpu" as const,
      platform: "macos" as const,
      name,
      readiness: listed,
      ...(Object.keys(details).length ? { details } : {}),
    };
  });
}

export const gpuDetector: Detector = {
  id: "gpu",
  version: 1,
  type: "gpu",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 30 * 60_000,
  timeoutMs: 9000,
  async detect(context) {
    if (context.platform === "darwin") return macGpus(context);
    const nvidiaSmi = findOnPath("nvidia-smi", context.env, context.platform);
    if (nvidiaSmi) return nvidiaGpus(context, nvidiaSmi);
    if (context.platform !== "linux") return [];
    const lspci = findOnPath("lspci", context.env, context.platform);
    return lspci ? pciGpus(context, lspci) : [];
  },
};
