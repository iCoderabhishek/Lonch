import type { Request, Response, NextFunction } from "express"
import { ApiError } from "../../../shared/libs/error"
import { prisma } from "../../../shared/libs/prisma"
import { triggerDeploy } from "../../../shared/services/deploy-service"

export const deploy = async (req: Request, res: Response, next: NextFunction) => {

    const userId = req.user?.userId
    const { repoUrl, projectId } = req.body
    try {


        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!projectId) {
            return res.status(400).json({ message: "Invalid request: missing projectId" })
        }
        // Fetch the project first to access stored repo URL
        const project = await prisma.project.findUnique({
            where: { id: projectId }
        })
        if (!project) {
            return res.status(404).json({ message: "Project not found" })
        }
        // repoUrl is optional for repeat deployments; use stored value if not provided
        const effectiveRepoUrl = repoUrl || project.repoUrl
        if (!effectiveRepoUrl) {
            return res.status(400).json({ message: "Invalid request: missing repoUrl" })
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


        // Use the resolved repoUrl for any further logic if needed (currently triggerDeploy only needs projectId)
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