import { Router, type Request, type Response } from "express";
import { processAwsEcsWebhook } from "../services/webhook-service";

const router = Router();

// We verify the API key passed in the headers by EventBridge to ensure security.
router.post("/aws/ecs", async (req: Request, res: Response) => {
    try {
        const apiKey = req.headers["x-api-key"];

        if (apiKey !== process.env.AWS_WEBHOOK_SECRET) {
            console.error("[Webhook Error] Unauthorized request attempt");
            return res.status(401).send("Unauthorized");
        }

        const payload = req.body;
        processAwsEcsWebhook(payload).catch(err => {
            console.error("[Webhook Error]", err);
        });

        res.status(200).send("OK");
    } catch (error) {
        console.error("Webhook processing error:", error);
        res.status(500).send("Internal Server Error");
    }
});

export default router;
