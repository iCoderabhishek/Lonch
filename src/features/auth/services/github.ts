import type { Request, Response, NextFunction } from "express"
import axios from "axios"
import { ApiError } from "../../../shared/libs/error"
import { prisma } from "../../../shared/libs/prisma"
import { issueTokens } from "../utils/token"

// read GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL from process.env
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID!
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL!

// ── Step 1: redirect handler ──────────────────────────────
export const githubRedirect = (req: Request, res: Response) => {
    // build https://github.com/login/oauth/authorize with query params:
    const url = "https://github.com/login/oauth/authorize?" +
        new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            redirect_uri: GITHUB_CALLBACK_URL,
            scope: "read:user user:email",
        })
    res.redirect(url)
}

// ── Step 2: callback handler (GitHub sends back ?code=) ───
export const githubCallback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code } = req.query;
        if (!code) {
            return next(ApiError.badRequest("Missing code"));
        }

        // 2. exchange code -> access_token
        const tokenResponse = await axios.post("https://github.com/login/oauth/access_token", {
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code,
        }, {
            headers: {
                Accept: "application/json",
            }
        });

        const { access_token } = tokenResponse.data;

        if (!access_token) {
            return next(ApiError.badRequest("Missing access token"));
        }

        // 3. fetch the profile
        const profileResponse = await axios.get("https://api.github.com/user", {
            headers: {
                Authorization: `Bearer ${access_token}`,
                "User-Agent": "lonch"
            }
        });

        let { id: githubId, login, avatar_url, email } = profileResponse.data;

        // 4. email may be null (private)
        if (!email) {
            const emailResponse = await axios.get("https://api.github.com/user/emails", {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                    "User-Agent": "lonch"
                }
            });

            const primaryEmailObj = emailResponse.data.find((e: any) => e.primary === true);
            if (primaryEmailObj) {
                email = primaryEmailObj.email;
            } else {
                email = `${login}@users.noreply.github.com`;
            }
        }

        // 5. upsert the user
        const user = await prisma.user.upsert({
            where: {
                githubId: String(githubId)
            },
            update: {
                email: email,
                avatar: avatar_url,
                name: login,
            },
            create: {
                email: email,
                avatar: avatar_url,
                name: login,
                githubId: String(githubId),
            }
        });

        // 6. issue YOUR OWN access + refresh tokens
        const { accessToken } = await issueTokens(user.id, res)
        res.json({ accessToken });

    } catch (error) {
        console.error("GitHub callback error:", error);
        next(error);
    }
}

