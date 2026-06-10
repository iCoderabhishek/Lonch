import express from "express"
import login from "../services/login";
import signup from "../services/signup";

const router = express.Router();

router.post("/login", login);
router.post("/signup", signup);

export default router;