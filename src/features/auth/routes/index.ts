import express from "express"
import login from "../services/login";
import signup from "../services/signup";
import { githubRedirect, githubCallback } from "../services/github";
import { refresh, logout } from "../services/session";

const router = express.Router();

router.post("/login", login);
router.post("/signup", signup);

router.get("/github", githubRedirect);
router.get("/github/callback", githubCallback);

router.post("/refresh", refresh);
router.post("/logout", logout);

export default router;