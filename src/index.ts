import "dotenv/config"
import express from "express"
import healthRoute from "./features/health/routes"
import authRoute from "./features/auth/routes"
import repoRoute from "./features/repo/routes"
import deployRoute from "./features/deploy/routes"
import { errorHandler } from "./shared/libs/error"
import cookieSession from "cookie-session"
import { COOKIE_DOMAIN } from "./shared/libs/env-lib"
import projectRoute from "./projects/routes";
import { proxyInterceptor } from "./features/proxy/middleware";

const app = express()

app.use(proxyInterceptor);

app.use(express.json())

app.use(cookieSession({
    name: 'session',
    keys: [process.env.COOKIE_SECRET as string],
    maxAge: 1000 * 60 * 60 * 24 * 7,
    secure: COOKIE_DOMAIN ? true : false,
    httpOnly: COOKIE_DOMAIN ? true : false,
    sameSite: COOKIE_DOMAIN ? "strict" : "lax",
    domain: COOKIE_DOMAIN,
    secureProxy: COOKIE_DOMAIN ? true : false,
}))

const PORT = process.env.PORT || 8080

// feature routes
app.use("/health", healthRoute)
app.use("/api/v1/auth", authRoute)
app.use("/api/v1/github", repoRoute)
app.use("/api/v1/deploy", deployRoute)
app.use("/api/v1/projects", projectRoute);

// libs handler
app.use(errorHandler)

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})

