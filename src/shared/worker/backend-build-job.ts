import { Worker } from "bullmq";
import { AWS_ECR_REPOSITORY_URI, AWS_S3_REGION, REDIS_URL } from "../libs/env-lib";
import { cloneRepository, createAndStartContainer, getProjectForDeploy, runCommandWithStreaming } from "./static-worker-utils";
import Docker from "dockerode"
import { updateDeploymentStatus } from "../services/deploy-service";
import { promisify } from "util";
import { execFile } from "child_process";
import {
    ECSClient,
    UpdateServiceCommand,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand
} from "@aws-sdk/client-ecs";
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

            await runCommandWithStreaming('docker', [
                "build",
                "-t",
                imageTag,
                "--no-cache",
                tempDir,
            ], deploymentId, tempDir);

            console.log(`[Worker] Image built successfully: ${imageTag}`);

            // push to aws ecr

            console.log(`[Worker] Authenticating with AWS ECR...`);

            // this command is used for getting the password for docker login to ecr 
            await execFileAsync('sh', ['-c', `aws ecr get-login-password --region ${AWS_S3_REGION} | docker login --username AWS --password-stdin ${AWS_ECR_REPOSITORY_URI}`])

            console.log(`[Worker] Pushing image to ECR...`);

            await updateDeploymentStatus(deploymentId, "PUSHING");

            await runCommandWithStreaming('docker', ['push', imageTag], deploymentId, tempDir);

            console.log(`[Worker] Image pushed successfully`);

            //  update aws ecs service (update ECS task definition)

            console.log(`[Worker] Updating ECS service...`);

            const ecsClient = new ECSClient({ region: AWS_S3_REGION });

            // in their sdk this is follows to deploy - https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ecs/
            //1. finding the current active task definition
            //2. pulling the current task definition
            //3. updating the image of the task definition
            //4. registering a new task definition
            //5. updating the service with the new task definition

            // i couldnt write this code without the api doc there. 
            // also thanks to this tutorial for understanding the flow from first principles- https://kevinkiruri.medium.com/deploying-a-container-with-amazon-ecs-d95dcab8b411

            // 1. Find the current active Task Definition
            const describeServiceResponse = await ecsClient.send(new DescribeServicesCommand({
                cluster: "lonch-production-cluster",
                services: [project.ecsServiceArn],
            }));

            const activeTaskDefArn = describeServiceResponse.services?.[0]?.taskDefinition;
            if (!activeTaskDefArn) {
                throw new Error("Could not find active Task Definition for service.");
            }

            // 2. Pull exact configuration of the Task Definition
            const describeTaskDefResponse = await ecsClient.send(new DescribeTaskDefinitionCommand({
                taskDefinition: activeTaskDefArn,
            }));

            const taskDef = describeTaskDefResponse.taskDefinition;
            if (!taskDef || !taskDef.containerDefinitions || taskDef.containerDefinitions.length === 0) {
                throw new Error("Invalid Task Definition structure returned from AWS.");
            }

            // 3. Map the user's project.envVars into AWS format
            const awsEnvVars = project.envVars.map((envVar: any) => ({
                name: envVar.key,
                value: envVar.value
            }));

            // 4. Modify the container definition's environment variables
            // Assuming the primary application container is the first one
            const primaryContainer = taskDef.containerDefinitions[0];
            if (!primaryContainer) {
                throw new Error("No container definitions found in the Task Definition.");
            }

            primaryContainer.environment = awsEnvVars;
            // Ensure the image points to the newly built image tag
            primaryContainer.image = imageTag;

            // 5. Create a new revision of the Task Definition
            const registerResponse = await ecsClient.send(new RegisterTaskDefinitionCommand({
                family: taskDef.family,
                containerDefinitions: taskDef.containerDefinitions,
                executionRoleArn: taskDef.executionRoleArn,
                taskRoleArn: taskDef.taskRoleArn,
                networkMode: taskDef.networkMode,
                requiresCompatibilities: taskDef.requiresCompatibilities,
                cpu: taskDef.cpu,
                memory: taskDef.memory,
            }));

            const newTaskDefArn = registerResponse.taskDefinition?.taskDefinitionArn;
            if (!newTaskDefArn) {
                throw new Error("Failed to register new Task Definition revision.");
            }

            // 6. Tell the cluster to deploy the newly created Task Definition Revision
            await ecsClient.send(
                new UpdateServiceCommand({
                    cluster: "lonch-production-cluster",
                    service: project.ecsServiceArn,
                    taskDefinition: newTaskDefArn,
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