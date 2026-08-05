import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/libs/prisma";
import { ApiError } from "../../shared/libs/error";

export async function getProjects(req: Request, res: Response, next: NextFunction) {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return next(ApiError.unauthorized("Unauthorized"));
        }

        const projects = await prisma.project.findMany({
            where: {
                ownerId: userId
            }
        });

        res.json({ projects });
    } catch (error) {
        next(error);
    }
}

export async function getProjectById(req: Request, res: Response, next: NextFunction) {
    try {
        const userId = req.user?.userId;
        const slug = req.params.slug as string;

        if (!userId || !slug) {
            return next(ApiError.badRequest("user Id and slug is required"))
        }

        const project = await prisma.project.findFirst({
            where: {
                slug,
                ownerId: userId
            }
        });

        return res.json({ project })
    } catch (error) {
        next(error)
    }
}