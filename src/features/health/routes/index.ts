import express from "express"

const router = express.Router()

router.get("/", (req, res) => {
    res.json({ status: "ok", deployed: true })
})

export default router