import express from "express";
import { getRepos, getBranches, getCommits } from "../../repo/services/repo";
import { authMiddleware } from "../../auth/middleware";

const router = express.Router();

router.get("/repos", authMiddleware, getRepos)
router.get("/repos/:owner/:repo/branches", authMiddleware, getBranches)
router.get("/repos/:owner/:repo/commits", authMiddleware, getCommits)

export default router;