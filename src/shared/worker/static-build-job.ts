import { Worker } from "bullmq";
import { REDIS_URL } from "../libs/env-lib";
import { updateDeploymentStatus } from "../services/deploy-service";
import Docker from "dockerode";
import {
    getProjectForDeploy,
    cloneRepository,
    createAndStartContainer,
    streamLogsToRedisAndDB,
    waitForContainerSuccess,
    uploadStaticAssetsToS3,
    cleanupResources
} from "./static-worker-utils";
import { autoDetectConfig } from "./project-detector";
import { workerLog } from "./logger";

export const staticDeployWorker = new Worker(
    "static-build",
    async (job) => {
        await workerLog(job.data.deploymentId, `Started processing job for deployment: ${job.data.deploymentId}`);
        const { deploymentId, projectId } = job.data;
        let tempDir = "";
        let container: Docker.Container | undefined;

        try {
            await updateDeploymentStatus(deploymentId, "BUILDING");

            let project = await getProjectForDeploy(projectId, "STATIC");

            // 1. Clone Repo
            tempDir = await cloneRepository(project, deploymentId);
            
            await workerLog(deploymentId, "Auto-detecting project configuration...");
            project = await autoDetectConfig(tempDir, project);

            // 2. Build Container & Stream Logs
            container = await createAndStartContainer(project, tempDir, deploymentId);
            const allLogs = await streamLogsToRedisAndDB(container, deploymentId);
            await waitForContainerSuccess(container, allLogs);

            // 3. Upload to S3
            await updateDeploymentStatus(deploymentId, "PUSHING");
            const publicUrl = await uploadStaticAssetsToS3(tempDir, project, deploymentId);

            // 4. Mark Success
            await updateDeploymentStatus(deploymentId, "SUCCESS", {
                url: publicUrl,
                staticS3Key: `projects/${projectId}/${deploymentId}`
            });

        } catch (error: any) {
            console.error(`[Worker Error]:`, error);
            await updateDeploymentStatus(deploymentId, "FAILED").catch(console.error);
            throw error;
        } finally {
            await cleanupResources(tempDir, container);
        }
    },
    { connection: { url: REDIS_URL } }
);

staticDeployWorker.on("error", (err) => {
    console.error("[Worker Connection Error]:", err);
});
