import type { Request, Response, NextFunction } from "express";
import { redis } from "../../../shared/libs/redis";
import { prisma } from "../../../shared/libs/prisma";

export interface FlushableResponse extends Response {
    flush?: () => void;
}

export const getBuildLogs = async (req: Request, res: FlushableResponse, next: NextFunction) => {
    const deploymentId = req.params.deploymentId as string;
    
    const deploymentCheck = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: { project: true }
    });
    
    // @ts-ignore
    if (!deploymentCheck || deploymentCheck.project.ownerId !== req.user?.userId) {
        res.status(404).json({ error: "Deployment not found" });
        return;
    }

    // sse headers 
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders(); // Send headers immediately to establish the SSE connection

    // First, send any stored logs from the database (for completed/past deployments)
    try {
        const storedLogs = await prisma.deploymentLog.findMany({
            where: { deploymentId },
            orderBy: { createdAt: "asc" },
        });

        for (const log of storedLogs) {
            res.write(`data: ${log.line}\n\n`);
        }

        if (typeof res.flush === 'function') {
            res.flush();
        }

        // Check if deployment is already finished — if so, close the stream
        const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { status: true },
        });

        if (deployment && ["SUCCESS", "FAILED"].includes(deployment.status)) {
            // Send a final event to tell the frontend the stream is done
            res.write(`data: [BUILD_COMPLETE]\n\n`);
            res.end();
            return;
        }
    } catch (err) {
        console.error("[SSE] Error fetching stored logs:", err);
    }

    // For active deployments, also subscribe to live Redis pub/sub
    const subscriber = redis.duplicate();

    await subscriber.subscribe(`deploy-log:${deploymentId}`);

    subscriber.on("message", (channel, message) => {
        if (channel === `deploy-log:${deploymentId}`) {
            console.log(`[SSE] Sending message to ${deploymentId}:`, message.substring(0, 50));
            res.write(`data: ${message}\n\n`);
            if (typeof res.flush === 'function') {
                res.flush();
            }
        }
    });

    // Keep connection alive against ALB 60s idle timeout
    const keepAliveInterval = setInterval(() => {
        res.write(':\n\n');
        if (typeof res.flush === 'function') {
            res.flush();
        }
    }, 30000);

    req.on("close", async () => {
        clearInterval(keepAliveInterval);
        await subscriber.unsubscribe();
        await subscriber.quit();
    })

}

// Also provide a REST endpoint for fetching stored logs without SSE
export const getStoredBuildLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const deploymentId = req.params.deploymentId as string;
        
        const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { project: true }
        });
        
        if (!deployment || deployment.project.ownerId !== req.user.userId) {
            return res.status(404).json({ error: "Deployment not found" });
        }

        const logs = await prisma.deploymentLog.findMany({
            where: { deploymentId },
            orderBy: { createdAt: "asc" },
            select: { line: true, stream: true, createdAt: true },
        });

        res.json({ logs });
    } catch (error) {
        next(error);
    }
}
