import express from "express"

import { githubRedirect, githubInstall, githubCallback } from "../services/github";
import { getMe, logout } from "../services/session";
import { authMiddleware } from "../middleware";

const router = express.Router();

router.get("/github", githubRedirect);
router.get("/github/install", githubInstall);
router.get("/github/callback", githubCallback);

router.post("/logout", logout);
router.get("/me", authMiddleware, getMe);

export default router;