import type { Project } from "@prisma/client";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import docker from "../docker";
import Docker from "dockerode";
import { redisPublisher } from "../libs/redis";
import { prisma } from "../libs/prisma";
import { uploadFolderToS3 } from "../libs/s3";
import { AWS_S3_REGION, AWS_S3_BUCKET_NAME } from "../libs/env-lib";
import fs from "fs/promises";
import { ApiError } from "../libs/error";

const execFileAsync = promisify(execFile);

export const getProjectForDeploy = async (projectId: string, expectedType: string) => {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, "Project not found");
    if (project.type !== expectedType) {
        throw new ApiError(400, `Expected ${expectedType} project, but got ${project.type}`);
    }
    if (project.disabled) {
        throw new ApiError(400, "Project is disabled");
    }
    return project;
};

export const cloneRepository = async (repoUrl: string, deploymentId: string) => {
    const tempDir = path.resolve("/tmp/builds", deploymentId);
    console.log(`[Worker] Cloning repository: ${repoUrl} into ${tempDir}...`);
    await execFileAsync('git', ['clone', repoUrl, tempDir]);
    console.log(`[Worker] Clone completed!`);
    return tempDir;
};

export const createAndStartContainer = async (project: Project, tempDir: string) => {
    const buildImage = project.baseImage || "node:22-alpine";
    console.log(`[Worker] Pulling Docker image: ${buildImage}...`);
    const { stdout, stderr } = await execFileAsync('docker', ['pull', buildImage]);
    console.log(`[Worker] Image pulled successfully. Details: ${stdout || stderr}`);

    const workingDir = project.rootDirectory ? path.posix.join("/app", project.rootDirectory) : "/app";

    const container = await docker.createContainer({
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
    await container.start();
    console.log(`[Worker] Container started.`);
    return container;
};

export const streamLogsToRedisAndDB = async (container: Docker.Container, deploymentId: string) => {
    const allLogs: { deploymentId: string, line: string, stream: string }[] = [];
    const stream = await container.logs({ follow: true, stdout: true, stderr: true });

    stream.on('data', (chunk) => {
        const logLine = chunk.toString('utf8');
        console.log(`[Worker] ${logLine}`);
        redisPublisher.publish(`deploy-log:${deploymentId}`, logLine);

        allLogs.push({
            deploymentId,
            line: logLine,
            stream: "stdout"
        });
    });

    return allLogs;
};

export const waitForContainerSuccess = async (container: Docker.Container, allLogs: any[]) => {
    const waitResult = await container.wait();
    if (allLogs.length > 0) {
        await prisma.deploymentLog.createMany({ data: allLogs }).catch(console.error);
    }
    if (waitResult.StatusCode !== 0) {
        throw new Error(`Build failed with exit code ${waitResult.StatusCode}`);
    }
};

export const uploadStaticAssetsToS3 = async (tempDir: string, project: Project, deploymentId: string) => {
    const outputPath = project.outDirectory || "dist";
    const localDistPath = path.join(tempDir, outputPath);

    console.log(`[Worker] Build completed! Uploading ${localDistPath} to S3...`);
    const s3Prefix = `projects/${project.id}/${deploymentId}`;
    await uploadFolderToS3(localDistPath, s3Prefix);
    console.log(`[Worker] Upload to S3 completed!`);

    return `https://${AWS_S3_BUCKET_NAME}.s3.${AWS_S3_REGION}.amazonaws.com/${s3Prefix}/index.html`;
};

export const cleanupResources = async (tempDir: string, container?: Docker.Container) => {
    if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(console.error);
    }
    if (container) {
        await container.remove().catch(console.error);
    }
};
