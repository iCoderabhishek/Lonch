import type { Request } from "express"

export const setAuthSession = (req: Request, accessToken: string, userId: string, refreshToken?: string) => {
    if (req.session) {
        req.session.access_token = accessToken
        req.session.userId = userId
        if (refreshToken) {
            req.session.refresh_token = refreshToken
        }
    }
}

export const clearAuthSession = (req: Request) => {
    req.session = null
}


export const readAuthSession = (req: Request) => {
    if (req.session && req.session.access_token && req.session.userId) {
        return {
            access_token: req.session.access_token as string,
            userId: req.session.userId as string,
            refresh_token: req.session.refresh_token as string | undefined,
        }
    }
    return null
}
