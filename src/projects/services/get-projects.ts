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
                ownerId: userId,
                disabled: false
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
                ownerId: userId,
                disabled: false
            },
            include: {
                deployments: {
                    orderBy: { createdAt: "desc" }
                },
                envVars: true
            }
        });

        if (!project) return res.status(404).json({ message: "Not found" });

        // Mask env variables by removing their actual value so it is hidden from the client
        const secureProject = {
            ...project,
            envVars: project.envVars.map(env => ({
                id: env.id,
                key: env.key
                // omitting value
            }))
        };

        return res.json({ project: secureProject })
    } catch (error) {
        next(error)
    }
}