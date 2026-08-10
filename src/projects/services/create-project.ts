import { ProjectType } from "@prisma/client";
import { prisma } from "../../shared/libs/prisma";
import { createProjectSchema } from "../../shared/schema/projects";
import type { Request, Response } from "express";

export async function createProject(req: Request, res: Response) {

    const { name, repoUrl, type, framework, buildCommand, installCommand, startCommand, outputDirectory, rootDirectory, baseImage, branch } = createProjectSchema.parse(req.body);

    if (!name || !repoUrl || !type) {
        return res.status(400).json({ message: "Name, repoUrl and type are required" });
    }

    const randomChars = Math.random().toString(36).substring(2, 8);
    const slug = `${name.toLowerCase().trim().replace(/\s+/g, '-')}-${randomChars}`;

    const existingProject = await prisma.project.findFirst({
        where: {
            ownerId: req.user.userId,
            slug
        }
    });

    if (existingProject) {
        return res.status(400).json({ message: "Project already exists" });
    }

    const project = await prisma.project.create({
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
            baseImage,
            branch: branch || "main",
            slug,
            ownerId: req.user.userId
        }
    });

    return res.status(201).json({ message: "Project created successfully", project });

}