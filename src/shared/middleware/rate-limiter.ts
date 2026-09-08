import type { Request, Response, NextFunction } from "express";
import { redis } from "../libs/redis";

interface RateLimitConfig {
    /** Max requests allowed in the window */
    maxRequests: number;
    /** Window size in seconds */
    windowSeconds: number;
    /** Optional prefix for Redis keys */
    keyPrefix?: string;
    /** Custom key extractor (defaults to IP) */
    keyExtractor?: (req: Request) => string;
    /** Custom message on rate limit */
    message?: string;
}

/**
 * Sliding-window rate limiter backed by Redis.
 * Uses a single atomic MULTI/EXEC to avoid race conditions.
 * No external packages needed — just ioredis which is already a dependency.
 */
export function rateLimiter(config: RateLimitConfig) {
    const {
        maxRequests,
        windowSeconds,
        keyPrefix = "rl",
        keyExtractor,
        message = "Too many requests. Please try again later.",
    } = config;

    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            // Use forwarded IP (from Caddy) or fall back to socket address
            const identifier = keyExtractor
                ? keyExtractor(req)
                : req.ip || req.socket.remoteAddress || "unknown";

            const key = `${keyPrefix}:${identifier}`;
            const now = Math.floor(Date.now() / 1000);
            const windowStart = now - windowSeconds;

            // Atomic sliding window using a sorted set:
            // 1. Remove entries older than the window
            // 2. Add the current request with timestamp as score
            // 3. Count entries in the window
            // 4. Set TTL on the key so it auto-expires
            const pipeline = redis.multi();
            pipeline.zremrangebyscore(key, 0, windowStart);
            pipeline.zadd(key, now, `${now}:${Math.random()}`);
            pipeline.zcard(key);
            pipeline.expire(key, windowSeconds);

            const results = await pipeline.exec();

            if (!results) {
                // Redis unavailable — fail open (allow request)
                return next();
            }

            const requestCount = results[2]?.[1] as number;

            // Set rate limit headers for transparency
            res.setHeader("X-RateLimit-Limit", maxRequests);
            res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - requestCount));
            res.setHeader("X-RateLimit-Reset", now + windowSeconds);

            if (requestCount > maxRequests) {
                res.setHeader("Retry-After", windowSeconds);
                return res.status(429).json({ error: message });
            }

            return next();
        } catch (error) {
            // If Redis is down, fail open — don't block legitimate users
            console.error("[RateLimiter] Redis error, failing open:", error);
            return next();
        }
    };
}
