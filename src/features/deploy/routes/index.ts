import express from "express"
import { deploy } from "../services/deploy"
import { rollbackDeployment } from "../services/rollback"
import { authMiddleware } from "../../auth/middleware"

const router = express.Router()

router.post("/", authMiddleware, deploy)
router.post("/:deploymentId/rollback", authMiddleware, rollbackDeployment)

export default router