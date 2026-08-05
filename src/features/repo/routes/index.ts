import express from "express";
import { getRepos } from "../../repo/services/repo";
import { authMiddleware } from "../../auth/middleware";

const router = express.Router();

router.get("/repos", authMiddleware, getRepos)

export default router;