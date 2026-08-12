import { ProjectType } from "@prisma/client";
import { prisma } from "../../shared/libs/prisma";
import { updateProjectSchema } from "../../shared/schema/projects";
import type { Request, Response } from "express";

export async function updateProject(req: Request, res: Response) {

    const { name, repoUrl, type, framework, buildCommand, installCommand, startCommand, outputDirectory, rootDirectory, envVars } = updateProjectSchema.parse(req.body);
    const slug = req.params.slug as string;

    if (!name || !repoUrl || !slug) {
        return res.status(400).json({ message: "Name, repoUrl and slug are required" });
    }

    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const existingProject = await prisma.project.findFirst({
        where: {
            ownerId: userId,
            slug,
            disabled: false
        }
    });

    if (!existingProject) {
        return res.status(400).json({ message: "Project does not exists" });
    }

    const project = await prisma.project.update({
        where: {
            slug
        },
        data: {
            name,
            repoUrl,
            type: type as "STATIC" | "BACKEND",
            framework,
            buildCommand,
            installCommand,
            startCommand,
            outDirectory: outputDirectory,
            rootDirectory,
        }
    });

    if (envVars) {
        // Sync env vars: delete existing, insert new ones (a more complex diff could be used, but this is simple and robust)
        await prisma.envVar.deleteMany({
            where: { projectId: project.id }
        });
        
        if (envVars.length > 0) {
            await prisma.envVar.createMany({
                data: envVars.map(ev => ({
                    projectId: project.id,
                    key: ev.key,
                    value: ev.value
                }))
            });
        }
    }

    return res.status(200).json({ message: "Project updated successfully", project });

}