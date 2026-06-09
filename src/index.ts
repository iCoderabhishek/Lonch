import express from "express"
import healthRoute from "./features/health/routes"
import authRoute from "./features/auth/routes"
import dotenv from "dotenv"

dotenv.config()

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 8080
app.use("/health", healthRoute)
app.use("/api/v1/auth", authRoute)

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})

