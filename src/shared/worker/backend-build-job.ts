import { Worker } from "bullmq";
import { AWS_ECR_REPOSITORY_URI, REDIS_URL } from "../libs/env-lib";
import { cloneRepository, getProjectForDeploy, runCommandWithStreaming } from "./static-worker-utils";
import Docker from "dockerode";
import { updateDeploymentStatus } from "../services/deploy-service";
import { promisify } from "util";
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { authenticateECR, ensureEcrRepositoryExists, provisionNewEcsService, updateExistingEcsService, waitForEcsService } from "./aws-backend-utils";
import { autoDetectConfig } from "./project-detector";
import { workerLog } from "./logger";

const execFileAsync = promisify(execFile);

export const backendDeployWorker = new Worker(
    "backend-build",
    async (job) => {
        await workerLog(job.data.deploymentId, `Started processing job for deployment: ${job.data.deploymentId}`);
        const { deploymentId, projectId } = job.data;
        let tempDir = "";
        try {
            await updateDeploymentStatus(deploymentId, "BUILDING");
            let project = await getProjectForDeploy(projectId, "BACKEND");

            // 1. clone the repo

            tempDir = await cloneRepository(project, deploymentId);
            
            await workerLog(deploymentId, "Auto-detecting project configuration...");
            project = await autoDetectConfig(tempDir, project);

            // 2. create dockerfile


            const dockerfilePath = path.join(tempDir, "Dockerfile");
            const dockerfileExists = await fs.access(dockerfilePath).then(() => true).catch(() => false);
            if (!dockerfileExists) {
                let dockerfileContent = `FROM ${project.baseImage || 'node:20-alpine'}\nWORKDIR /app\nCOPY . .\n`;
                if (project.installCommand) {
                    dockerfileContent += `RUN ${project.installCommand}\n`;
                }
                if (project.buildCommand) {
                    dockerfileContent += `RUN ${project.buildCommand}\n`;
                }
                dockerfileContent += `CMD ["sh", "-c", "${project.startCommand || 'npm start'}"]\n`;
                await fs.writeFile(dockerfilePath, dockerfileContent);
            }
            const imageTag = `${AWS_ECR_REPOSITORY_URI}:${deploymentId}`;

            await workerLog(deploymentId, `Building Docker image...`);
            await runCommandWithStreaming('docker', [
                "build", "-t", imageTag, "--no-cache", tempDir,
            ], deploymentId, tempDir);
            await workerLog(deploymentId, `Image built successfully: ${imageTag}`);

            // 3. push image to ECR


            await ensureEcrRepositoryExists(deploymentId);
            await authenticateECR(deploymentId);

            await workerLog(deploymentId, `Pushing image to ECR...`);
            await updateDeploymentStatus(deploymentId, "PUSHING", { imageUri: imageTag });
            await runCommandWithStreaming('docker', ['push', imageTag], deploymentId, tempDir);
            await workerLog(deploymentId, `Image pushed successfully`);

            const appPort = project.port || 3000;

            if (!project.ecsServiceArn) {
                await provisionNewEcsService(project, imageTag, appPort, deploymentId);
            } else {
                try {
                    await updateExistingEcsService(project, imageTag, appPort, deploymentId);
                } catch (updateErr: any) {
                    await workerLog(deploymentId, `Failed to update existing ECS service (${updateErr.message}). The saved ARN might be invalid or deleted. Falling back to provisioning a new service...`);
                    await provisionNewEcsService(project, imageTag, appPort, deploymentId);
                }
            }

            // 4. update deployment status

            await workerLog(deploymentId, `ECS update triggered. Marking deployment as SUCCESS.`);
            await updateDeploymentStatus(deploymentId, "SUCCESS");
            
            // Note: We bypassed ECS stable wait and marked as SUCCESS immediately as requested.
            // When AWS finishes the deployment in a few minutes, it will be fully live.
            
            await workerLog(deploymentId, ``);
            await workerLog(deploymentId, `======================================================`);
            await workerLog(deploymentId, `🚀 DEPLOYMENT TRIGGERED SUCCESSFULLY!`);
            await workerLog(deploymentId, `AWS is now spinning up your containers in the background.`);
            await workerLog(deploymentId, `🌍 Production: https://${project.slug}.lonch.cloud`);
            await workerLog(deploymentId, `======================================================`);
            await workerLog(deploymentId, ``);

        } catch (error: any) {
            console.error(`[Worker Error]:`, error);
            await updateDeploymentStatus(deploymentId, "FAILED").catch(console.error);
        } finally {
            if (tempDir) {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(console.error);
            }
            const imageTag = `${AWS_ECR_REPOSITORY_URI}:${deploymentId}`;
            await execFileAsync('docker', ['rmi', imageTag]).catch(() => { });
        }
    },
    { connection: { url: REDIS_URL } }
);