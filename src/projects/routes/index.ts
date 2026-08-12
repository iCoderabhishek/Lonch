import express from "express";
import { getProjects, getProjectById } from "../services/get-projects";
import { authMiddleware } from "../../features/auth/middleware";
import { createProject } from "../services/create-project";
import { updateProject } from "../services/update-project";
import { deleteProject } from "../services/delete-project";
import { getRollbackEligibility } from "../../features/deploy/services/rollback";
import { setCustomDomain } from "../services/set-custom-domain";
import { verifyCustomDomain } from "../services/verify-custom-domain";

const router = express.Router()

router.get("/", authMiddleware, getProjects);
router.get("/:slug", authMiddleware, getProjectById);
router.post("/", authMiddleware, createProject);
router.put("/:slug", authMiddleware, updateProject);
router.get("/:slug/rollback-eligibility", authMiddleware, getRollbackEligibility);
router.post("/:slug/domain", authMiddleware, setCustomDomain);
router.get("/:slug/domain/verify", authMiddleware, verifyCustomDomain);
router.delete("/:slug", authMiddleware, deleteProject);

export default router;