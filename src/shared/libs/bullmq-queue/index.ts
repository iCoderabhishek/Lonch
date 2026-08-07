import { Queue } from "bullmq"
import { REDIS_URL } from "../env-lib/index"

if (!REDIS_URL) {
    throw new Error("REDIS_URL environment variable is missing!")
}

export const deployQueue = new Queue("deployments", { connection: { url: REDIS_URL } })
export const buildQueue = new Queue("deploy-job", { connection: { url: REDIS_URL } });
