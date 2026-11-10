import * as React from "react";
import * as RechartsPrimitive from "recharts";
import type {
  DefaultLegendContentProps,
  DefaultTooltipContentProps,
} from "recharts";
import { cn } from "../../lib/cn";

const THEMES = { light: "", dark: ".dark" } as const;
const INITIAL_DIMENSION = { height: 200, width: 320 } as const;

type TooltipValue = string | number | Array<string | number>;
type TooltipName = string | number;

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function useChart(): { config: ChartConfig } {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }
  return context;
}

export function ChartContainer({
  children,
  className,
  config,
  id,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  children: React.ReactElement;
  config: ChartConfig;
  initialDimension?: { height: number; width: number };
}) {
  const uniqueId = React.useId().replaceAll(":", "");
  const chartId = `chart-${id ?? uniqueId}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          "flex aspect-video min-w-0 justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-ink-muted [&_.recharts-cartesian-grid_line]:stroke-line-soft [&_.recharts-curve.recharts-tooltip-cursor]:stroke-line [&_.recharts-dot]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-inset [&_.recharts-surface]:outline-hidden",
          className,
        )}
        data-chart={chartId}
        data-slot="chart"
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        <RechartsPrimitive.ResponsiveContainer
          height="100%"
          initialDimension={initialDimension}
          minHeight={0}
          minWidth={0}
          width="100%"
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export function ChartStyle({
  config,
  id,
}: {
  config: ChartConfig;
  id: string;
}) {
  const colorConfig = Object.entries(config).filter(
    ([, item]) => item.theme || item.color,
  );
  if (!colorConfig.length) return null;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `${prefix} [data-chart="${id}"] {
${colorConfig
  .map(([key, item]) => {
    const color =
      item.theme?.[theme as keyof typeof item.theme] ?? item.color;
    return color ? `  --color-${key}: ${color};` : "";
  })
  .join("\n")}
}`,
          )
          .join("\n"),
      }}
    />
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

export function ChartTooltipContent({
  active,
  className,
  color,
  formatter,
  hideIndicator = false,
  hideLabel = false,
  indicator = "dot",
  label,
  labelClassName,
  labelFormatter,
  labelKey,
  nameKey,
  payload,
  valueFormatter,
}: React.ComponentProps<"div"> &
  Omit<
    DefaultTooltipContentProps<TooltipValue, TooltipName>,
    "accessibilityLayer"
  > & {
    active?: boolean;
    hideIndicator?: boolean;
    hideLabel?: boolean;
    indicator?: "line" | "dot" | "dashed";
    labelKey?: string;
    nameKey?: string;
    valueFormatter?: (value: TooltipValue) => React.ReactNode;
  }) {
  const { config } = useChart();
  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`;
    const itemConfig = getPayloadConfig(config, item, key);
    const value =
      !labelKey && typeof label === "string"
        ? (config[label]?.label ?? label)
        : itemConfig?.label;
    if (labelFormatter) {
      return (
        <div className={cn("font-medium", labelClassName)}>
          {labelFormatter(value, payload)}
        </div>
      );
    }
    return value ? (
      <div className={cn("font-medium", labelClassName)}>{value}</div>
    ) : null;
  }, [config, hideLabel, label, labelClassName, labelFormatter, labelKey, payload]);

  if (!active || !payload?.length) return null;
  const nestLabel = payload.length === 1 && indicator !== "dot";
  return (
    <div
      className={cn(
        "grid min-w-36 items-start gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-xs text-ink shadow-floating",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`;
            const itemConfig = getPayloadConfig(config, item, key);
            const indicatorColor =
              color ?? item.payload?.fill ?? item.color ?? "var(--fdy-accent)";
            return (
              <div
                className={cn(
                  "flex w-full flex-wrap items-center gap-2",
                  indicator === "dot" && "items-center",
                )}
                key={`${key}:${index}`}
              >
                {formatter && item.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : hideIndicator ? null : (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "shrink-0 rounded-xs",
                          indicator === "dot" && "size-2",
                          indicator === "line" && "h-2.5 w-0.5",
                          indicator === "dashed" &&
                            "h-2.5 w-0 border border-dashed",
                        )}
                        style={{
                          backgroundColor:
                            indicator === "dashed"
                              ? "transparent"
                              : indicatorColor,
                          borderColor: indicatorColor,
                        }}
                      />
                    )}
                    <span className="min-w-0 flex-1 text-ink-muted">
                      {itemConfig?.label ?? item.name}
                    </span>
                    {item.value != null ? (
                      <span className="font-mono font-medium text-ink tabular-nums">
                        {valueFormatter
                          ? valueFormatter(item.value)
                          : typeof item.value === "number"
                            ? item.value.toLocaleString()
                            : String(item.value)}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

export const ChartLegend = RechartsPrimitive.Legend;

export function ChartLegendContent({
  className,
  hideIcon = false,
  nameKey,
  payload,
  verticalAlign = "bottom",
}: React.ComponentProps<"div"> &
  DefaultLegendContentProps & {
    hideIcon?: boolean;
    nameKey?: string;
  }) {
  const { config } = useChart();
  if (!payload?.length) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item, index) => {
          const key = `${nameKey ?? item.dataKey ?? "value"}`;
          const itemConfig = getPayloadConfig(config, item, key);
          return (
            <div
              className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted"
              key={`${key}:${index}`}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-xs"
                  style={{ backgroundColor: item.color }}
                />
              )}
              <span className="min-w-0 truncate">{itemConfig?.label}</span>
            </div>
          );
        })}
    </div>
  );
}

function getPayloadConfig(
  config: ChartConfig,
  payload: unknown,
  key: string,
) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const nested =
    "payload" in payload &&
    typeof payload.payload === "object" &&
    payload.payload !== null
      ? payload.payload
      : undefined;
  let configKey = key;
  if (
    key in payload &&
    typeof payload[key as keyof typeof payload] === "string"
  ) {
    configKey = payload[key as keyof typeof payload] as string;
  } else if (
    nested &&
    key in nested &&
    typeof nested[key as keyof typeof nested] === "string"
  ) {
    configKey = nested[key as keyof typeof nested] as string;
  }
  return configKey in config ? config[configKey] : config[key];
}
