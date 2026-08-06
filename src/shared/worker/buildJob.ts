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
import { uploadArtifactToS3 } from "../libs/s3";
import docker from "../docker"


// creating this helper to make sure only valid transitions are allowed
export const assertValidTransition = (from: DeploymentStatus, to: DeploymentStatus) => {
    try {
        const allowed: Record<DeploymentStatus, DeploymentStatus[]> = {
            [DeploymentStatus.QUEUED]: [DeploymentStatus.BUILDING, DeploymentStatus.CANCELLED],
            [DeploymentStatus.BUILDING]: [DeploymentStatus.PUSHING, DeploymentStatus.FAILED, DeploymentStatus.CANCELLED],
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

export const updateDeploymentStatus = async (id: string, newStatus: DeploymentStatus) => {
    const deployment = await prisma.deployment.findUnique({ where: { id } });
    if (!deployment) throw new ApiError(404, "Deployment not found");
    assertValidTransition(deployment.status, newStatus);
    return await prisma.deployment.update({
        where: { id },
        data: { status: newStatus }
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
        const { deploymentId, projectId } = job.data;
        let tempDir = "";
        let container: Docker.Container | undefined;

        try {
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
            await execFileAsync('git', ['clone', project.repoUrl, tempDir]);

            // 3. Create Docker Container
            const buildImage = project.baseImage || "node:22-alpine";

            container = await docker.createContainer({
                Image: buildImage,
                Tty: true,
                Cmd: ["/bin/sh", "-c", `${project.installCommand} && ${project.buildCommand}`],
                HostConfig: {
                    Binds: [`${tempDir}:/app`],
                    Memory: project.maxMemory || 1024 * 1024 * 1024,
                    NetworkMode: "bridge",
                },
                WorkingDir: project.rootDirectory || "/app",
            });

            // 4. start the container and stream logs
            await container.start();

            const allLogs: { deploymentId: string, line: string, stream: string }[] = [];

            const stream = await container.logs({ follow: true, stdout: true, stderr: true });
            stream.on('data', (chunk) => {
                // we should stream the log live via websocket
                allLogs.push({
                    deploymentId,
                    line: chunk.toString('utf8'),
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
            // 6. extract the built assets (eg: /app/dist)
            const archiveStream = await container.getArchive({ path: `/app/${outputPath}` });

            // 7. upload to S3
            await updateDeploymentStatus(deploymentId, "PUSHING");
            await uploadArtifactToS3(deploymentId, archiveStream);

            // 8. Cleanup and mark SUCCESS
            await container.remove();
            await updateDeploymentStatus(deploymentId, "SUCCESS");

        } catch (error: any) {
            // Handle failure
            console.error(error);
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
