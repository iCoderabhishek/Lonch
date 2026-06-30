import express from "express"
import healthRoute from "./features/health/routes"
import authRoute from "./features/auth/routes"
import repoRoute from "./features/repo/routes"
import deployRoute from "./features/deploy/routes"
import dotenv from "dotenv"
import { errorHandler } from "./shared/libs/error"
import cookieParser from "cookie-parser"

dotenv.config()

const app = express()
app.use(express.json())
app.use(cookieParser())

const PORT = process.env.PORT || 8080

// feature routes
app.use("/health", healthRoute)
app.use("/api/v1/auth", authRoute)
app.use("/api/v1/github", repoRoute)
app.use("/api/v1/deploy", deployRoute)
// libs handler
app.use(errorHandler)

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})

