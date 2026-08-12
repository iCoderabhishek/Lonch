import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../../shared/libs/prisma";
import { ApiError } from "../../../shared/libs/error";
import { updateExistingEcsService } from "../../../shared/worker/aws-backend-utils";

export const getRollbackEligibility = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const slug = req.params.slug as string;
        const project = await prisma.project.findFirst({
            where: { slug, ownerId: req.user.userId, disabled: false }
        });

        if (!project) {
            return next(ApiError.notFound("Project not found"));
        }

        const successfulDeployments = await prisma.deployment.count({
            where: {
                projectId: project.id,
                status: "SUCCESS"
            }
        });

        res.json({
            isRollbackable: successfulDeployments > 1,
            successfulDeployments
        });

    } catch (err) {
        next(err);
    }
}

export const rollbackDeployment = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const deploymentId = req.params.deploymentId as string;
        const targetDeployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { project: true }
        }) as any;

        if (!targetDeployment) {
            return next(ApiError.notFound("Deployment not found"));
        }
        
        if (!targetDeployment.project || targetDeployment.project.ownerId !== req.user.userId || targetDeployment.project.disabled) {
            return next(ApiError.forbidden("You do not own this project or it has been deleted"));
        }

        if (targetDeployment.status !== "SUCCESS") {
            return next(ApiError.badRequest("Cannot rollback to a deployment that did not succeed"));
        }

        const project = targetDeployment.project;

        // Create a new deployment record to represent the rollback action
        const newDeployment = await prisma.deployment.create({
            data: {
                projectId: project.id,
                status: "QUEUED",
                ecsServiceArm: targetDeployment.ecsServiceArm || ""
            }
        });

        if (project.type === "STATIC") {
            // For static, rollback is instantaneous. Just duplicate the S3 key and URL.
            await prisma.deployment.update({
                where: { id: newDeployment.id },
                data: {
                    status: "SUCCESS",
                    staticS3Key: targetDeployment.staticS3Key,
                    url: targetDeployment.url
                }
            });
            return res.json({ message: "Rollback successful", deployment: newDeployment });
        } else if (project.type === "BACKEND") {
            if (!targetDeployment.imageUri) {
                return next(ApiError.badRequest("Cannot rollback. No image URI found for this deployment."));
            }

            const appPort = project.port || 3000;
            
            await prisma.deployment.update({
                where: { id: newDeployment.id },
                data: { status: "DEPLOYING", imageUri: targetDeployment.imageUri }
            });

            // Trigger the AWS ECS update directly since it's instantaneous to trigger
            await updateExistingEcsService(project, targetDeployment.imageUri, appPort, newDeployment.id);

            return res.json({ 
                message: "Rollback triggered successfully. Containers are restarting with the previous image.", 
                deployment: newDeployment 
            });
        }
    } catch (err) {
        next(err);
    }
}
