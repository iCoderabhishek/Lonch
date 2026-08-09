import type { Request, Response, NextFunction } from "express";
import { redis } from "../../../shared/libs/redis";

export const getBuildLogs = async (req: Request, res: Response, next: NextFunction) => {
    const deploymentId = req.params.deploymentId;

    // sse headers 

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const subscriber = redis.duplicate();
    await subscriber.connect();

    await subscriber.subscribe(`deploy-log:${deploymentId}`, (message: any) => {
        res.write(`data: ${message}\n\n`);
    });

    req.on("close", async () => {
        await subscriber.unsubscribe();
        await subscriber.quit();
    })

}

// after i built the frontend will use this built in api EventSource for listening.. like const eventSource = new EventSource(`/api/v1/logs/123/deploy-logs`);
