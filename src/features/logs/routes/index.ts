import { Router } from "express"
import { getBuildLogs } from "../services/subscriber"
import { getRuntimeLogs } from "../services/cloudwatch"
import { authMiddleware } from "../../auth/middleware";

const router = Router()

router.get("/deployments/:deploymentId/build", authMiddleware, getBuildLogs)
router.get("/projects/:projectId/runtime", authMiddleware, getRuntimeLogs)

export default router