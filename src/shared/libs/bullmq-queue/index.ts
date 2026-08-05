import { Queue } from "bullmq"
import { REDIS_URL } from "../env-lib/index"

export const deployQueue = new Queue("deployments", { connection: { url: REDIS_URL } })