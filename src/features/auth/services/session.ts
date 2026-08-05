import type { Request, Response, NextFunction } from "express"
import { clearAuthSession, readAuthSession } from "../utils/token"

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

    res.json({
        accessToken: session.access_token,
        userId: session.userId,
        refreshToken: session.refresh_token,
    })
}