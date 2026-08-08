import { Worker } from "bullmq";
import { AWS_ECR_REPOSITORY_URI, AWS_S3_REGION, REDIS_URL } from "../libs/env-lib";
import { cloneRepository, createAndStartContainer, getProjectForDeploy } from "./static-worker-utils";
import Docker from "dockerode"
import { updateDeploymentStatus } from "../services/deploy-service";
import { promisify } from "util";
import { execFile } from "child_process";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import fs from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

export const backendDeployWorker = new Worker(
    "backend-build",
    async (job) => {
        console.log(`[Worker] Started processing job for deployment: ${job.data.deploymentId}`);
        const { deploymentId, projectId } = job.data;
        let tempDir = "";
        let container: Docker.Container | undefined;
        try {
            await updateDeploymentStatus(deploymentId, "BUILDING");
            const project = await getProjectForDeploy(projectId, "BACKEND");
            if (!project.ecsServiceArn) throw new Error("ECS Service ARN not found for project");


            const dockerfilePath = path.join(tempDir, "Dockerfile");
            const dockerfileExists = await fs.access(dockerfilePath).then(() => true).catch(() => false);
            if (!dockerfileExists) {
                await fs.writeFile(dockerfilePath, `
                    FROM ${project.baseImage}
                    WORKDIR /app
                    COPY . .
                    RUN ${project.buildCommand}
                    CMD ["sh", "-c", "${project.startCommand || 'npm start'}"]
                `);
            }

            tempDir = await cloneRepository(project.repoUrl, deploymentId);
            const imageTag = `${AWS_ECR_REPOSITORY_URI}:${deploymentId}`;

            console.log(`[Worker] Building Docker image...`);


            await execFileAsync('docker', [
                "build",
                "-t",
                imageTag,
                "--no-cache",
                tempDir,
            ]);

            console.log(`[Worker] Image built successfully: ${imageTag}`);

            // push to aws ecr

            console.log(`[Worker] Authenticating with AWS ECR...`);

            // this command is used for getting the password for docker login to ecr 
            await execFileAsync('sh', ['-c', `aws ecr get-login-password --region ${AWS_S3_REGION} | docker login --username AWS --password-stdin ${AWS_ECR_REPOSITORY_URI}`])

            console.log(`[Worker] Pushing image to ECR...`);

            await updateDeploymentStatus(deploymentId, "PUSHING");

            await execFileAsync('docker', ['push', imageTag])

            console.log(`[Worker] Image pushed successfully`);

            //  update aws ecs service (update ECS task definition)

            console.log(`[Worker] Updating ECS service...`);

            const ecsClient = new ECSClient({ region: AWS_S3_REGION });

            // Tell ECS to force a new deployment, which will pull the "latest" image (or specific tag)

            await ecsClient.send(
                new UpdateServiceCommand({
                    cluster: "lonch-production-cluster",
                    service: project.ecsServiceArn,
                    forceNewDeployment: true,
                })
            );

            console.log(`[Worker] ECS update triggered. Marking deployment as SUCCESS.`);
            await updateDeploymentStatus(deploymentId, "SUCCESS");

        } catch (error: any) {
            console.error(`[Worker Error]:`, error);
            await updateDeploymentStatus(deploymentId, "FAILED").catch(console.error);
        } finally {
            if (tempDir) {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(console.error);
            }
            // cleanup
            const imageTag = `${AWS_ECR_REPOSITORY_URI}:${deploymentId}`;
            await execFileAsync('docker', ['rmi', imageTag]).catch(() => { });
        }

    },
    { connection: { url: REDIS_URL } }
);