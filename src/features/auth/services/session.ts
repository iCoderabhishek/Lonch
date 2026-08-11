import type { Request, Response, NextFunction } from "express"
import { clearAuthSession, readAuthSession } from "../utils/token"
import { prisma } from "../../../shared/libs/prisma"

export const logout = async (req: Request, res: Response, next: NextFunction) => {
    clearAuthSession(req)
    res.json({ message: "Logged out" })
}


export const getMe = async (req: Request, res: Response, next: NextFunction) => {
    const session = readAuthSession(req)
    if (!session) {
        res.status(401).json({ message: "Unauthorized" })
        return
    }

    const user = await prisma.user.findUnique({
        where: { id: session.userId }
    })

    if (!user) {
        res.status(401).json({ message: "Unauthorized" })
        return
    }

    res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        avatar: user.avatar,
        githubInstallationId: user.githubInstallationId,
        accessToken: session.access_token,
        userId: session.userId,
        refreshToken: session.refresh_token,
    })
}