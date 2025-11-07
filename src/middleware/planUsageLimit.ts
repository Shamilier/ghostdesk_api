import type { RequestHandler } from "express";
import { logger } from "../lib/logger";

export type PlanUsageEndpoint = "hint" | "ask";

export interface PlanUsageLimitOptions {
  windowMs: number;
  defaultPlan: string;
  plans: Record<string, { hint: number; ask: number } | null>;
}

interface UsageBucket {
  count: number;
  resetAt: number;
}

function resolveLimit(
  options: PlanUsageLimitOptions,
  planName: string | undefined,
  endpoint: PlanUsageEndpoint
): number | null {
  const normalizedPlan = (planName ?? options.defaultPlan).toLowerCase();
  const plans = options.plans;
  const hasPlan = Object.prototype.hasOwnProperty.call(plans, normalizedPlan);
  const entry = hasPlan ? plans[normalizedPlan] : plans[options.defaultPlan];
  if (entry === null || entry === undefined) {
    return null;
  }
  const limit = entry[endpoint];
  return typeof limit === "number" ? limit : null;
}

function headerName(suffix: string) {
  return `X-Usage-${suffix}`;
}

export function createPlanUsageLimiter(options: PlanUsageLimitOptions) {
  const buckets = new Map<string, UsageBucket>();

  function makeKey(userId: string, plan: string, endpoint: PlanUsageEndpoint) {
    return `${plan}:${endpoint}:${userId}`;
  }

  function middleware(endpoint: PlanUsageEndpoint): RequestHandler {
    return (req, res, next) => {
      const user = req.user;
      if (!user?.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const planName = (user.plan ?? options.defaultPlan).toLowerCase();
      const limit = resolveLimit(options, planName, endpoint);

      if (limit === null) {
        res.setHeader(headerName("Plan"), planName);
        res.setHeader(headerName("Limit"), "unlimited");
        return next();
      }

      const now = Date.now();
      const key = makeKey(user.id, planName, endpoint);
      let bucket = buckets.get(key);

      if (!bucket || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + options.windowMs };
        buckets.set(key, bucket);
      }

      if (bucket.count >= limit) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader(headerName("Plan"), planName);
        res.setHeader(headerName("Limit"), String(limit));
        res.setHeader(headerName("Remaining"), "0");
        res.setHeader(headerName("Reset"), new Date(bucket.resetAt).toISOString());

        logger.warn("plan_limit.hit", {
          user_id: user.id,
          plan: planName,
          endpoint,
          limit,
          window_ms: options.windowMs,
        });

        return res.status(429).json({
          error: "Usage limit exceeded",
          message: "Лимит запросов для вашего плана превышен",
          plan: planName,
          endpoint,
          limit,
          windowMs: options.windowMs,
          resetAt: new Date(bucket.resetAt).toISOString(),
        });
      }

      bucket.count += 1;
      res.setHeader(headerName("Plan"), planName);
      res.setHeader(headerName("Limit"), String(limit));
      res.setHeader(headerName("Remaining"), String(Math.max(limit - bucket.count, 0)));
      res.setHeader(headerName("Reset"), new Date(bucket.resetAt).toISOString());

      return next();
    };
  }

  return {
    limit: middleware,
  };
}
