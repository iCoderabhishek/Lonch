import { Worker } from "bullmq";
import { REDIS_URL } from "../libs/env-lib";


export const backendDeployWorker = new Worker(
    "backend-build",
    async (job) => {

        // 1. clone repo
        // 2. build docker image (docker build)
        // 3. push to aws ecr
        // 4. update aws ecs service (update ECS task definition)

    },
    { connection: { url: REDIS_URL } }
)