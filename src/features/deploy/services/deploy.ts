import type { Request, Response, NextFunction } from "express"
import { ApiError } from "../../../shared/libs/error"
import { prisma } from "../../../shared/libs/prisma"
import { triggerDeploy } from "../../../shared/worker/buildJob"

export const deploy = async (req: Request, res: Response, next: NextFunction) => {

    const userId = req.user?.userId
    const { repoUrl, projectId } = req.body
    try {


        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!repoUrl || !projectId) {
            return res.status(400).json({ message: "Invalid request" })
        }

        const project = await prisma.project.findUnique({
            where: {
                id: projectId
            }
        })

        if (!project) {
            return res.status(404).json({ message: "Project not found" })
        }

        if (project.ownerId !== userId) {
            return res.status(403).json({ message: "You are not allowed to do this action" })
        }

        const latestDeployment = await prisma.deployment.findFirst({
            where: {
                projectId
            },
            orderBy: {
                createdAt: "desc"
            }
        })

        if (latestDeployment && latestDeployment.status === "BUILDING") {
            return res.status(400).json({ message: "A deployment is already in progress" })
        }

        const newDeployment = await triggerDeploy(projectId);

        return res.status(200).json({
            message: "Deployment queued successfully",
            deployment: newDeployment
        });

    }
    catch (error: any) {
        throw new ApiError(400, error.message)
    }

}