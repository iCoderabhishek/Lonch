import type { Request, Response, NextFunction } from "express"
import { ApiError } from "../../../shared/libs/error"
import { prisma } from "../../../shared/libs/prisma"
import { issueTokens, verifyRefreshToken, clearAuthCookies, readRefreshToken, revokeTokens } from "../utils/token"

// Swap a valid refresh token for a fresh access token (and rotate the refresh token).
export const refresh = async (req: Request, res: Response, next: NextFunction) => {
    const token = readRefreshToken(req)
    if (!token) {
        return next(ApiError.unauthorized("Missing refresh token"))
    }

    let payload: { id: string }
    try {
        payload = verifyRefreshToken(token)
    } catch {
        return next(ApiError.unauthorized("Invalid or expired refresh token"))
    }

    const user = await prisma.user.findUnique({ where: { id: payload.id } })

    if (!user || user.refreshToken !== token) {
        return next(ApiError.unauthorized("Refresh token revoked"))
    }

    // rotation: issueTokens overwrites the stored refresh token, invalidating this one
    const { accessToken } = await issueTokens(user.id, res)
    res.json({ accessToken })
}

export const logout = async (req: Request, res: Response, next: NextFunction) => {
    const token = readRefreshToken(req)
    if (token) {
        try {
            const { id } = verifyRefreshToken(token)
            await revokeTokens(id)
        } catch {
            return next(ApiError.unauthorized("Invalid or expired refresh token"))
        }
    }

    clearAuthCookies(res)
    res.json({ message: "Logged out" })
}
