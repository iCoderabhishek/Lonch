import type { NextFunction, Request, Response } from "express";
import { readAuthSession } from "../utils/token";

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const session = readAuthSession(req)

    if (!session) {
        return res.status(401).json({ message: "Unauthorized: No valid session found" })
    }


    req.user = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        userId: session.userId
    }

    next()
}