import { redisPublisher } from "../libs/redis";
import { prisma } from "../libs/prisma";

export const workerLog = async (deploymentId: string, message: string, stream: string = "stdout") => {
    // 1. Console log for backend visibility
    console.log(`[Worker] ${message}`);
    
    // 2. Stream to Redis for real-time frontend SSE
    redisPublisher.publish(`deploy-log:${deploymentId}`, message);

    // 3. Store in DB for historical frontend logs
    try {
        await prisma.deploymentLog.create({
            data: {
                deploymentId,
                line: message,
                stream
            }
        });
    } catch (error) {
        console.error(`[Worker Log Error]: Failed to save log to DB`, error);
    }
};
