import { prisma } from "../../shared/libs/prisma";
import type { Request, Response } from "express";
import { teardownQueue } from "../../shared/libs/bullmq-queue";

export async function deleteProject(req: Request, res: Response) {

    const slug = req.params.slug as string;

    if (!slug) {
        return res.status(400).json({ message: "Slug is required" });
    }

    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const existingProject = await prisma.project.findFirst({
        where: {
            ownerId: userId,
            slug
        }
    });

    if (!existingProject) {
        return res.status(404).json({ message: "Project does not exist" });
    }

    const project = await prisma.project.update({
        where: {
            slug
        },
        data: {
            disabled: true
        },
        include: {
            deployments: true,
            envVars: true,
            projectRunComands: true
        }
    });

    // Queue the teardown job
    await teardownQueue.add("teardown-build", {
        projectId: project.id,
        slug: project.slug,
        type: project.type,
        ecsServiceArn: project.ecsServiceArn
    });

    return res.status(202).json({ message: "Project deleted successfully", project });

}