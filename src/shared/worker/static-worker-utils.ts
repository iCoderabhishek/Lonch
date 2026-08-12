import type { Project } from "@prisma/client";
import { execFile, spawn } from "child_process";
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
import { workerLog } from "./logger";
import { getInstallationToken } from "../libs/github";

const execFileAsync = promisify(execFile);

export const getProjectForDeploy = async (projectId: string, expectedType: string) => {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
            envVars: true,
            owner: true
        }
    });
    if (!project) throw new ApiError(404, "Project not found");
    if (project.type !== expectedType) {
        throw new ApiError(400, `Expected ${expectedType} project, but got ${project.type}`);
    }
    if (project.disabled) {
        throw new ApiError(400, "Project is disabled");
    }
    return project;
};

export const cloneRepository = async (project: any, deploymentId: string) => {
    const tempDir = path.resolve("/tmp/builds", deploymentId);
    const branch = project.branch || "main";

    // Ensure clean state before cloning
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });

    let cloneUrl = project.repoUrl;
    if (project.owner?.githubInstallationId) {
        try {
            const token = await getInstallationToken(project.owner.githubInstallationId);
            // Insert token into the GitHub URL
            cloneUrl = project.repoUrl.replace("https://", `https://x-access-token:${token}@`);
        } catch (err) {
            console.error("Failed to get installation token for clone:", err);
            // fallback to public url
        }
    }

    await workerLog(deploymentId, `Cloning repository: ${project.repoUrl} (branch: ${branch}) into ${tempDir}...`);
    try {
        await execFileAsync('git', ['clone', '--single-branch', '--branch', branch, cloneUrl, tempDir]);
    } catch (error: any) {
        if (error.stderr && error.stderr.includes(`Remote branch ${branch} not found`)) {
            await workerLog(deploymentId, `Branch '${branch}' not found. Falling back to the repository's default branch...`, "stderr");
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { }); // cleanup again just in case
            await execFileAsync('git', ['clone', '--single-branch', cloneUrl, tempDir]);
        } else {
            throw error;
        }
    }

    await workerLog(deploymentId, `Clone completed!`);
    return tempDir;
};

export const createAndStartContainer = async (project: Project, tempDir: string, deploymentId: string) => {
    const buildImage = project.baseImage || "node:22-alpine";
    await workerLog(deploymentId, `Pulling Docker image: ${buildImage}...`);
    const { stdout, stderr } = await execFileAsync('docker', ['pull', buildImage]);
    await workerLog(deploymentId, `Image pulled successfully. Details: ${stdout || stderr}`);

    const workingDir = project.rootDirectory ? path.posix.join("/app", project.rootDirectory) : "/app";

    const container = await docker.createContainer({
        Image: buildImage,
        Tty: true,
        Cmd: ["/bin/sh", "-c", `${project.installCommand} && ${project.buildCommand}`],
        HostConfig: {
            Binds: [`${tempDir}:/app`],
            Memory: Math.max(project.maxMemory || 0, 2560 * 1024 * 1024),
            NetworkMode: "bridge",
        },
        WorkingDir: workingDir,
    });

    await workerLog(deploymentId, `Docker container created. Starting container...`);
    await container.start();
    await workerLog(deploymentId, `Container started.`);
    return container;
};

export const streamLogsToRedisAndDB = async (container: Docker.Container, deploymentId: string) => {
    const allLogs: { deploymentId: string, line: string, stream: string }[] = [];
    const stream = await container.logs({ follow: true, stdout: true, stderr: true });

    stream.on('data', (chunk) => {
        const logData = chunk.toString('utf8');
        logData.split('\n').filter(Boolean).forEach((line: string) => {
            console.log(`[Worker] ${line}`);
            redisPublisher.publish(`deploy-log:${deploymentId}`, line);

            allLogs.push({
                deploymentId,
                line: line,
                stream: "stdout"
            });
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

    await workerLog(deploymentId, `Build completed! Uploading ${localDistPath} to S3...`);
    const s3Prefix = `projects/${project.id}/${deploymentId}`;
    await uploadFolderToS3(localDistPath, s3Prefix);
    await workerLog(deploymentId, `Upload to S3 completed!`);

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

export const runCommandWithStreaming = (command: string, args: string[], deploymentId: string, cwd?: string) => {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd });
        const allLogs: any[] = [];

        const log = (data: any, stream: string) => data.toString().split('\n').filter(Boolean).forEach((line: string) => {
            console.log(`[Worker] ${line}`);
            redisPublisher.publish(`deploy-log:${deploymentId}`, line);
            allLogs.push({ deploymentId, line, stream });
        });

        child.stdout.on('data', d => log(d, 'stdout'));
        child.stderr.on('data', d => log(d, 'stderr'));

        child.on('close', async (code) => {
            if (allLogs.length) await prisma.deploymentLog.createMany({ data: allLogs }).catch(console.error);
            code === 0 ? resolve(true) : reject(new Error(`Command failed with code ${code}`));
        });
        child.on('error', reject);
    });
};
