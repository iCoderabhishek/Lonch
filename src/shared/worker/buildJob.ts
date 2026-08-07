import { DeploymentStatus } from "@prisma/client"
import { ApiError } from "../libs/error"
import { Worker } from "bullmq"
import { prisma } from "../libs/prisma"
import { REDIS_URL } from "../libs/env-lib"
import { buildQueue } from "../libs/bullmq-queue"
import Docker from "dockerode";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { uploadFolderToS3 } from "../libs/s3";
import docker from "../docker"
import { AWS_S3_REGION, AWS_S3_BUCKET_NAME } from "../libs/env-lib";


// creating this helper to make sure only valid transitions are allowed
export const assertValidTransition = (from: DeploymentStatus, to: DeploymentStatus) => {
    try {
        const allowed: Record<DeploymentStatus, DeploymentStatus[]> = {
            [DeploymentStatus.QUEUED]: [DeploymentStatus.BUILDING, DeploymentStatus.CANCELLED],
            [DeploymentStatus.BUILDING]: [DeploymentStatus.BUILDING, DeploymentStatus.PUSHING, DeploymentStatus.FAILED, DeploymentStatus.CANCELLED],
            [DeploymentStatus.SUCCESS]: [],
            [DeploymentStatus.FAILED]: [],
            [DeploymentStatus.CANCELLED]: [],
            [DeploymentStatus.PUSHING]: [DeploymentStatus.SUCCESS, DeploymentStatus.FAILED]
        }
        const nextStatuses = allowed[from]
        if (!nextStatuses.includes(to)) {
            throw new Error(`Invalid deployment transition from ${from} to ${to}`)
        }
    }
    catch (error: any) {
        throw new ApiError(400, error.message)
    }
}

export const updateDeploymentStatus = async (id: string, newStatus: DeploymentStatus, extraData: any = {}) => {
    const deployment = await prisma.deployment.findUnique({ where: { id } });
    if (!deployment) throw new ApiError(404, "Deployment not found");
    assertValidTransition(deployment.status, newStatus);
    return await prisma.deployment.update({
        where: { id },
        data: { status: newStatus, ...extraData }
    });
}



export async function triggerDeploy(projectId: string) {
    const deployment = await prisma.deployment.create({
        data: {
            projectId,
            status: "QUEUED",
            ecsServiceArm: "" // will change when i build backend deployment 
        }
    });

    await buildQueue.add("build", { deploymentId: deployment.id, projectId });
    return deployment;
}





const execFileAsync = promisify(execFile);


// for this v1 only making the static sites deployed
export const deployWorker = new Worker(
    "deploy-job",
    async (job) => {
        console.log(`[Worker] Started processing job for deployment: ${job.data.deploymentId}`);
        const { deploymentId, projectId } = job.data;
        let tempDir = "";
        let container: Docker.Container | undefined;

        try {
            console.log(`[Worker] Marking as BUILDING...`);
            // 1. Mark as BUILDING
            await updateDeploymentStatus(deploymentId, "BUILDING");

            // 2. Clone the repositoryy
            const project = await prisma.project.findUnique({ where: { id: projectId } });

            if (!project) throw new ApiError(404, "Project not found");

            if (project.type !== "STATIC") {
                throw new ApiError(400, "Backend site deployment is not supported yet");
            }
            if (project.disabled) {
                throw new ApiError(400, "Project is disabled");
            }

            tempDir = path.resolve("/tmp/builds", deploymentId);
            console.log(`[Worker] Cloning repository: ${project.repoUrl} into ${tempDir}...`);
            await execFileAsync('git', ['clone', project.repoUrl, tempDir]);
            console.log(`[Worker] Clone completed!`);

            // 3. Create Docker Container
            const buildImage = project.baseImage || "node:22-alpine";
            
            console.log(`[Worker] Pulling Docker image: ${buildImage}...`);
            await new Promise((resolve, reject) => {
                docker.pull(buildImage, (err: any, stream: any) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, 
                        (err: any, output: any) => {
                            if (err) return reject(err);
                            resolve(output);
                        },
                        (event: any) => {
                            if (event.status && event.progress) {
                                console.log(`[Worker] Pulling: ${event.status} - ${event.progress}`);
                            }
                        }
                    );
                });
            });
            console.log(`[Worker] Image pulled successfully.`);

            const workingDir = project.rootDirectory ? path.posix.join("/app", project.rootDirectory) : "/app";

            container = await docker.createContainer({
                Image: buildImage,
                Tty: true,
                Cmd: ["/bin/sh", "-c", `${project.installCommand} && ${project.buildCommand}`],
                HostConfig: {
                    Binds: [`${tempDir}:/app`],
                    Memory: project.maxMemory || 1024 * 1024 * 1024,
                    NetworkMode: "bridge",
                },
                WorkingDir: workingDir,
            });
            console.log(`[Worker] Docker container created. Starting container...`);

            // 4. start the container and stream logs
            await container.start();
            console.log(`[Worker] Container started. Waiting for logs...`);

            const allLogs: { deploymentId: string, line: string, stream: string }[] = [];

            const stream = await container.logs({ follow: true, stdout: true, stderr: true });
            stream.on('data', (chunk) => {
                const logLine = chunk.toString('utf8');
                console.log(`[Worker] ${logLine}`);
                // we should stream the log live via websocket
                allLogs.push({
                    deploymentId,
                    line: logLine,
                    stream: "stdout"
                });
            });

            const waitResult = await container.wait();

            if (allLogs.length > 0) {
                await prisma.deploymentLog.createMany({ data: allLogs }).catch(console.error);
            }
            if (waitResult.StatusCode !== 0) {
                throw new Error(`Build failed with exit code ${waitResult.StatusCode}`);
            }

            const outputPath = project.outDirectory || "dist";
            const localDistPath = path.join(tempDir, outputPath);

            console.log(`[Worker] Build completed! Uploading ${localDistPath} to S3...`);
            // 7. upload to S3
            await updateDeploymentStatus(deploymentId, "PUSHING");
            const s3Prefix = `projects/${projectId}/${deploymentId}`;
            await uploadFolderToS3(localDistPath, s3Prefix);
            console.log(`[Worker] Upload to S3 completed!`);

            // 8. Cleanup and mark SUCCESS
            await container.remove();

            const publicUrl = `https://${AWS_S3_BUCKET_NAME}.s3.${AWS_S3_REGION}.amazonaws.com/${s3Prefix}/index.html`;

            await updateDeploymentStatus(deploymentId, "SUCCESS", {
                url: publicUrl,
                staticS3Key: s3Prefix
            });

        } catch (error: any) {
            // Handle failure
            console.error(`[Worker Error]:`, error);
            await updateDeploymentStatus(deploymentId, "FAILED").catch(console.error);
            throw error;
        } finally {
            // Cleanup temp directory
            if (tempDir) {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(console.error);
            }
            if (container) {
                await container.remove().catch(console.error);
            }
        }
    },
    { connection: { url: REDIS_URL, } }
);

deployWorker.on("error", (err) => {
    console.error("[Worker Connection Error]:", err);
});
