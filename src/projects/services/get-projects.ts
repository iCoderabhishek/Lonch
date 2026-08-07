import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../shared/libs/prisma";
import { ApiError } from "../../shared/libs/error";
import { DEPLOYMENT_DOMAIN } from "../../shared/libs/env-lib";

export async function getProjects(req: Request, res: Response, next: NextFunction) {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return next(ApiError.unauthorized("Unauthorized"));
        }

        const projects = await prisma.project.findMany({
            where: {
                ownerId: userId
            },
            include: {
                deployments: {
                    where: { status: "SUCCESS" },
                    orderBy: { createdAt: "desc" },
                    take: 1
                }
            }
        });

        // add the dynamically generated live URL if there is a successful deployment.....
        const projectsWithUrls = projects.map(p => {
            const hasDeployment = p.deployments && p.deployments.length > 0;
            const protocol = DEPLOYMENT_DOMAIN.includes("localhost") ? "http" : "https";
            return {
                ...p,
                liveUrl: hasDeployment ? `${protocol}://${p.slug}.${DEPLOYMENT_DOMAIN}` : null,
            };
        });

        res.json({ projects: projectsWithUrls });
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