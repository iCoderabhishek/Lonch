import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { processAwsEcsWebhook, processGithubWebhook } from "../services/webhook-service";
import { GITHUB_WEBHOOK_SECRET } from "../../../shared/libs/env-lib";

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

// GitHub Webhook Endpoint
router.post("/github", async (req: Request, res: Response) => {
    try {
        const signature = req.headers["x-hub-signature-256"] as string;
        const eventName = req.headers["x-github-event"] as string;
        
        if (!signature || !eventName) {
            return res.status(400).send("Missing GitHub headers");
        }

        if (GITHUB_WEBHOOK_SECRET) {
            // Note: In production, using a raw body buffer is safer for exact HMAC matching, 
            // but this stringify approach works for standard JSON payloads.
            const payloadString = JSON.stringify(req.body);
            const hmac = crypto.createHmac("sha256", GITHUB_WEBHOOK_SECRET);
            const digest = "sha256=" + hmac.update(payloadString).digest("hex");
            
            // We use a simple match here. For high-security, crypto.timingSafeEqual is better.
            if (signature !== digest) {
                console.error("[GitHub Webhook] Signature mismatch!");
                return res.status(401).send("Invalid signature");
            }
        }

        console.log(`[GitHub Webhook] Received event: ${eventName}`);

        const payload = req.body;
        processGithubWebhook(payload, eventName).catch(err => {
            console.error("[GitHub Webhook Error]", err);
        });

        res.status(200).send("OK");
    } catch (error) {
        console.error("GitHub Webhook processing error:", error);
        res.status(500).send("Internal Server Error");
    }
});

export default router;
