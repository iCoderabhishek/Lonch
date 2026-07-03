import { Redis } from "ioredis"
import { REDIS_URL } from "../env-lib"

export const redis = new Redis(
    REDIS_URL,
    // {
    //     maxRetriesPerRequest: 0
    // }
)