import "dotenv/config"
import express from "express"
import healthRoute from "./features/health/routes"
import authRoute from "./features/auth/routes"
import repoRoute from "./features/repo/routes"
import deployRoute from "./features/deploy/routes"
import { errorHandler } from "./shared/libs/error"
import cookieSession from "cookie-session"
import cors from "cors"
import { COOKIE_DOMAIN, FRONTEND_URL } from "./shared/libs/env-lib"
import projectRoute from "./projects/routes";
import { proxyInterceptor } from "./features/proxy/middleware";
import logRoute from "./features/logs/routes";
import webhookRoute from "./features/deploy/routes/webhooks";
import { rateLimiter } from "./shared/middleware/rate-limiter";
import "./shared/worker/index"; // Initialize BullMQ workers

const app = express()

app.use(cors({
    origin: FRONTEND_URL,
    credentials: true,
}))

app.use(proxyInterceptor);

app.use(express.json({ limit: "2mb" }))
app.set("trust proxy", 1);

app.use(cookieSession({
    name: 'session',
    keys: [process.env.COOKIE_SECRET as string],
    maxAge: 1000 * 60 * 60 * 24 * 7,
    secure: COOKIE_DOMAIN ? true : false,
    httpOnly: COOKIE_DOMAIN ? true : false,
    sameSite: "lax",
    domain: COOKIE_DOMAIN,
    secureProxy: COOKIE_DOMAIN ? true : false,
}))

const PORT = process.env.PORT || 8080

// Global rate limiter: 100 requests per 60s per IP
app.use(rateLimiter({
    maxRequests: 100,
    windowSeconds: 60,
    keyPrefix: "rl:global",
    message: "Too many requests. Please slow down.",
}));

// App-key guard removed: API is now accessed directly by the browser (secured by CORS and Session)

// feature routes
app.use("/health", healthRoute)
app.use("/api/v1/auth", authRoute)
app.use("/api/v1/github", repoRoute)
app.use("/api/v1/deploy", deployRoute)
app.use("/api/v1/projects", projectRoute);
app.use("/api/v1/logs", logRoute);
app.use("/api/v1/webhooks", webhookRoute)

// Stricter rate limit on auth routes (10 requests per 60s)
app.use("/api/v1/auth", rateLimiter({
    maxRequests: 10,
    windowSeconds: 60,
    keyPrefix: "rl:auth",
    message: "Too many auth attempts. Please wait.",
}));

// libs handler
app.use(errorHandler)

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})

