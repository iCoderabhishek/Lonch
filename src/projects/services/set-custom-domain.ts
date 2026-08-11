import { type Request, type Response } from "express";
import { prisma } from "../../shared/libs/prisma";

export const setCustomDomain = async (req: Request, res: Response) => {
    try {
        const slug = req.params.slug as string;
        const { domain } = req.body;
        // @ts-ignore - req.user is populated by authMiddleware
        const userId = req.user?.id; 

        if (!domain) {
            return res.status(400).json({ error: "Domain is required" });
        }

        const project = await prisma.project.findUnique({
            where: { slug }
        });

        if (!project) {
            return res.status(404).json({ error: "Project not found" });
        }

        if (project.ownerId !== userId) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        // Check if there's at least one successful deployment
        const successfulDeployments = await prisma.deployment.count({
            where: {
                projectId: project.id,
                status: "SUCCESS"
            }
        });

        if (successfulDeployments === 0) {
            return res.status(400).json({ error: "Project must have at least one successful deployment before setting a custom domain." });
        }

        // Check if domain is already taken
        const existingDomain = await prisma.project.findUnique({
            where: { customDomain: domain }
        });

        if (existingDomain && existingDomain.id !== project.id) {
            return res.status(400).json({ error: "This domain is already in use by another project." });
        }

        const updatedProject = await prisma.project.update({
            where: { id: project.id },
            data: { customDomain: domain }
        });

        return res.status(200).json(updatedProject);
    } catch (error) {
        console.error("Error setting custom domain:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};
