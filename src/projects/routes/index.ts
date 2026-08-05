import express from "express";
import { getProjects, getProjectById } from "../services/get-projects";
import { authMiddleware } from "../../features/auth/middleware";
import { createProject } from "../services/create-project";
import { updateProject } from "../services/update-project";

const router = express.Router()

router.get("/", authMiddleware, getProjects);
router.get("/:slug", authMiddleware, getProjectById);
router.post("/", authMiddleware, createProject);
router.put("/:slug", authMiddleware, updateProject);

export default router;