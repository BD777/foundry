import type {
  UsageStatsDimension,
  UsageStatsGranularity,
  UsageStatsResult,
} from "@bd777/foundry-protocol";
import { request, type RequestOptions } from "./http";

export interface UsageStatsQuery extends RequestOptions {
  from: Date;
  granularity: UsageStatsGranularity;
  groupBy?: UsageStatsDimension[];
  limit?: number;
  offset?: number;
  to: Date;
  userId?: string;
}

/** Reads aggregate usage; an empty `groupBy` requests one row per time bucket. */
export function getUsageStats({
  from,
  granularity,
  groupBy,
  limit = 500,
  offset = 0,
  signal,
  to,
  userId,
}: UsageStatsQuery): Promise<UsageStatsResult> {
  const query = new URLSearchParams({
    from: from.toISOString(),
    granularity,
    limit: String(limit),
    offset: String(offset),
    to: to.toISOString(),
  });
  if (groupBy) query.set("groupBy", groupBy.join(","));
  if (userId) query.set("userId", userId);
  return request<UsageStatsResult>("GET", `/api/usage-stats?${query}`, {
    signal,
  });
}
