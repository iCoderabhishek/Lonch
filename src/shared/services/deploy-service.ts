import { prisma } from "../libs/prisma";
import { staticBuildQueue, backendBuildQueue } from "../libs/bullmq-queue";
import { ApiError } from "../libs/error";
import { DeploymentStatus } from "@prisma/client";

export async function triggerDeploy(projectId: string) {
    const deployment = await prisma.deployment.create({
        data: {
            projectId,
            status: "QUEUED",
            ecsServiceArm: "" // will change when i build backend deployment 
        }
    });
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, "Project not found");

    if (project.type == "STATIC") {
        await staticBuildQueue.add("deploy-static", { deploymentId: deployment.id, projectId });
    } else if (project.type == "BACKEND") {
        await backendBuildQueue.add("deploy-backend", { deploymentId: deployment.id, projectId });
    }
    return deployment;
}


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
