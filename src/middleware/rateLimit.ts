import type { RequestHandler } from "express";
import { logger } from "../lib/logger";

interface RateLimitOptions {
  windowMs: number;
  limit: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimiter({ windowMs, limit }: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || "unknown";
    const now = Date.now();
    const bucket = buckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfter, 1)));
      logger.warn("rate_limit.hit", { ip, window_ms: windowMs, limit });
      return res.status(429).json({ error: "Too many requests" });
    }

    bucket.count += 1;
    return next();
  };
}
