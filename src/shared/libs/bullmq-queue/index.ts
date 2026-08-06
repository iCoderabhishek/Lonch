import { Queue } from "bullmq"
import { REDIS_URL } from "../env-lib/index"

export const deployQueue = new Queue("deployments", { connection: { url: REDIS_URL } })

export const buildQueue = new Queue("deploy-job", { connection: { url: process.env.REDIS_URL } });
