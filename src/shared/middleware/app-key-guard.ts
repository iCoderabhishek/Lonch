import type { Request, Response, NextFunction } from "express";

/**
 * Validates the X-App-Key header on incoming requests.
 *
 * This is the strongest proxy-level defense against bots:
 * - The frontend sends a secret key in every request header.
 * - Bots don't know this key, so they can't forge it.
 * - Even if a bot spoofs the User-Agent and Origin, it still
 *   gets blocked here.
 *
 * Paths that are excluded (webhooks, health) are handled at the
 * Caddy layer — but we double-check here at the app level too.
 */
export function appKeyGuard(req: Request, res: Response, next: NextFunction) {
    // Exclude paths that don't come from the browser
    if (
        req.path.startsWith("/api/v1/webhooks") ||
        req.path.startsWith("/health") ||
        req.path.startsWith("/api/v1/auth")
    ) {
        return next();
    }

    // Skip for proxy-intercepted project requests (subdomain routing)
    // These are end-user requests to deployed projects, not API calls
    if (!req.path.startsWith("/api/")) {
        return next();
    }

    const appKey = req.headers["x-app-key"] as string | undefined;
    const expectedKey = process.env.APP_SECRET_KEY;

    if (!expectedKey) {
        // If the env var is not set, skip the check (dev mode safety)
        console.warn("[AppKeyGuard] APP_SECRET_KEY not set — skipping guard. Set it in production!");
        return next();
    }

    if (!appKey || appKey !== expectedKey) {
        return res.status(403).json({ error: "Forbidden" });
    }

    return next();
}
