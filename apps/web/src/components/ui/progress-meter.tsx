import type { ComponentPropsWithoutRef } from "react";
import "./progress-meter.css";

/** A labelled, native progress indicator; an absent value is indeterminate. */
export function ProgressMeter({
  className = "",
  ...props
}: ComponentPropsWithoutRef<"progress">) {
  return <progress {...props} className={`fdy-progress-meter ${className}`} />;
}
