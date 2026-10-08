import type { DeviceProjection } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";

const gibibytes = (bytes: number) =>
  `${(bytes / 1024 ** 3).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} GB`;

/** One line telling devices apart in lists: system, architecture, user. */
export function deviceSummary(device: DeviceProjection): string | undefined {
  const system = device.system;
  if (!system) return undefined;
  return [
    [system.os, system.osVersion].filter(Boolean).join(" "),
    system.arch,
    system.user,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the machine is, as its worker reported it at registration. */
export function DeviceDetails({ device }: { device: DeviceProjection }) {
  const { t } = useTranslation("devices");
  const system = device.system;
  if (!system)
    return <p className="fdy-device-details-missing">{t("details.missing")}</p>;
  const rows: [string, string | undefined][] = [
    [t("details.hostname"), system.hostname],
    [
      t("details.system"),
      [system.os, system.osVersion].filter(Boolean).join(" "),
    ],
    [t("details.kernel"), system.kernel],
    [
      t("details.cpu"),
      system.cpuModel
        ? t("details.cpuValue", {
            model: system.cpuModel,
            count: system.cpuCount ?? 0,
            arch: system.arch,
          })
        : system.arch,
    ],
    [
      t("details.memory"),
      system.memoryBytes ? gibibytes(system.memoryBytes) : undefined,
    ],
    [t("details.user"), system.user],
    [t("details.worker"), device.worker?.version],
    [t("details.node"), system.nodeVersion],
  ];
  return (
    <dl className="fdy-device-details">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}
