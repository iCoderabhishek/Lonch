import express from "express"
import { deploy } from "../services/deploy"

const router = express.Router()

router.post("/", deploy)

export default router