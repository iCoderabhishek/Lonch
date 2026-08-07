import express from "express"
import { deploy } from "../services/deploy"
import { authMiddleware } from "../../auth/middleware"

const router = express.Router()

router.post("/", authMiddleware, deploy)

export default router