import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../../shared/libs/prisma"
import { ApiError } from "../../../shared/libs/error"
import { getInstallationToken } from "../../../shared/libs/github"
import axios from "axios"


export const getRepos = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { githubInstallationId: true }
        });

        if (!user?.githubInstallationId) {
            return next(ApiError.badRequest("Not installed with GitHub app"));
        }

        // mint a GitHub-issued token for this installation (our session JWT is no good here)
        const installationToken = await getInstallationToken(user.githubInstallationId);

        const response = await axios.get(
            "https://api.github.com/installation/repositories?per_page=100&sort=updated",
            {
                headers: {
                    Authorization: `Bearer ${installationToken}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "lonch",
                },
            }
        );

        // slim DTO — don't hand the frontend GitHub's full repo objects
        const repos = response.data.repositories.map((r: any) => ({
            id: r.id,
            name: r.name,
            fullName: r.full_name,
            private: r.private,
            defaultBranch: r.default_branch,
            updatedAt: r.updated_at,
            owner: { login: r.owner?.login, avatar: r.owner?.avatar_url },
        })).sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

        res.json({ repos });
    } catch (error) {
        console.error("GitHub repos error:", error);
        next(error);
    }
}
