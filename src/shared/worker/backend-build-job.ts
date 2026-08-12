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

const execFileAsync = promisify(execFile);

export const backendDeployWorker = new Worker(
    "backend-build",
    async (job) => {
        console.log(`[Worker] Started processing job for deployment: ${job.data.deploymentId}`);
        const { deploymentId, projectId } = job.data;
        let tempDir = "";
        try {
            await updateDeploymentStatus(deploymentId, "BUILDING");
            let project = await getProjectForDeploy(projectId, "BACKEND");

            // 1. clone the repo


            tempDir = await cloneRepository(project.repoUrl, deploymentId, project.branch);

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

            console.log(`[Worker] Building Docker image...`);
            await runCommandWithStreaming('docker', [
                "build", "-t", imageTag, "--no-cache", tempDir,
            ], deploymentId, tempDir);
            console.log(`[Worker] Image built successfully: ${imageTag}`);

            // 3. push image to ECR


            await ensureEcrRepositoryExists();
            await authenticateECR();

            console.log(`[Worker] Pushing image to ECR...`);
            await updateDeploymentStatus(deploymentId, "PUSHING", { imageUri: imageTag });
            await runCommandWithStreaming('docker', ['push', imageTag], deploymentId, tempDir);
            console.log(`[Worker] Image pushed successfully`);

            const appPort = project.port || 3000;

            if (!project.ecsServiceArn) {
                await provisionNewEcsService(project, imageTag, appPort);
            } else {
                try {
                    await updateExistingEcsService(project, imageTag, appPort);
                } catch (updateErr: any) {
                    console.error(`[Worker] Failed to update existing ECS service (${updateErr.message}). The saved ARN might be invalid or deleted. Falling back to provisioning a new service...`);
                    await provisionNewEcsService(project, imageTag, appPort);
                }
            }

            // 4. update deployment status

            console.log(`[Worker] ECS update triggered. Marking deployment as SUCCESS.`);
            await updateDeploymentStatus(deploymentId, "SUCCESS");
            
            // Note: We bypassed ECS stable wait and marked as SUCCESS immediately as requested.
            // When AWS finishes the deployment in a few minutes, it will be fully live.
            
            console.log(`\n======================================================`);
            console.log(`🚀 DEPLOYMENT TRIGGERED SUCCESSFULLY!`);
            console.log(`AWS is now spinning up your containers in the background.`);
            console.log(`🌍 Production: https://${project.slug}.lonch.cloud`);
            console.log(`💻 Local Test: http://${project.slug}.localhost:8080`);
            console.log(`======================================================\n`);

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