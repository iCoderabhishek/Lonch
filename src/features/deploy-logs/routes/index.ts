import { Router } from "express"
import { getLogs } from "../services/subscriber"
import { authMiddleware } from "../../auth/middleware";

const router = Router()

router.get("/:deploymentId/deploy-logs", authMiddleware, getLogs)

export default router