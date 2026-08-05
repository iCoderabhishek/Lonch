import { ProjectType } from "@prisma/client";
import { prisma } from "../../shared/libs/prisma";
import { updateProjectSchema } from "../../shared/schema/projects";
import type { Request, Response } from "express";

export async function updateProject(req: Request, res: Response) {

    const { name, repoUrl, type, framework, buildCommand, installCommand, startCommand, outputDirectory, rootDirectory } = updateProjectSchema.parse(req.body);
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
            slug
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

    return res.status(200).json({ message: "Project updated successfully", project });

}