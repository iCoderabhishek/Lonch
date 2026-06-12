import type { Response, Request } from "express"
import jwt from "jsonwebtoken"
import { prisma } from "../../../shared/libs/prisma"

const JWT_SECRET = process.env.JWT_SECRET!
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!

// token lifetimes
const ACCESS_TOKEN_TTL = "15m"
const REFRESH_TOKEN_TTL = "7d"

// cookie maxAge is in MILLISECONDS
const ACCESS_COOKIE_MAX_AGE = 15 * 60 * 1000            // 15 minutes
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000  // 7 days

export const readRefreshToken = (req: Request): string | undefined =>
    req.cookies?.refresh_token || req.body?.refreshToken


export const generateAccessToken = (userId: string) =>
    jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL })

export const generateRefreshToken = (userId: string) =>
    jwt.sign({ id: userId }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL })

export const verifyRefreshToken = (token: string) =>
    jwt.verify(token, JWT_REFRESH_SECRET) as { id: string }

export const setAuthCookies = (res: Response, accessToken: string, refreshToken: string) => {
    const isProd = process.env.NODE_ENV === "production"

    res.cookie("auth_token", accessToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
        maxAge: ACCESS_COOKIE_MAX_AGE,
    })

    // refresh cookie is only ever sent to the auth routes
    res.cookie("refresh_token", refreshToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: "strict",
        maxAge: REFRESH_COOKIE_MAX_AGE,
        path: "/api/v1/auth",
    })
}

export const clearAuthCookies = (res: Response) => {
    res.clearCookie("auth_token")
    res.clearCookie("refresh_token", { path: "/api/v1/auth" })
}

/**
 * Mint an access + refresh token pair for a user, persist the refresh token
 * (so it can be checked / revoked later), and set both as httpOnly cookies.
 * Returns the access token for callers that also want it in the response body.
 */
export const issueTokens = async (userId: string, res: Response) => {
    const accessToken = generateAccessToken(userId)
    const refreshToken = generateRefreshToken(userId)

    await prisma.user.update({
        where: { id: userId },
        data: { refreshToken },
    })

    setAuthCookies(res, accessToken, refreshToken)

    return { accessToken, refreshToken }
}


export const revokeTokens = async (userId: string) => {
    await prisma.user.update({
        where: { id: userId },
        data: { refreshToken: null },
    })
}