import express from "express";
import { getRepos } from "../../repo/services/repo";
import { middleware } from "../../auth/middleware";

const router = express.Router();

router.get("/repos", middleware, getRepos)

export default router;