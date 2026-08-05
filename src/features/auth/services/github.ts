import type { Request, Response, NextFunction } from "express"
import axios from "axios"
import { ApiError } from "../../../shared/libs/error"
import { prisma } from "../../../shared/libs/prisma"
import { setAuthSession } from "../utils/token"
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL, GITHUB_APP_NAME } from "../../../shared/libs/env-lib";

// ── Step 1: redirect handler ──────────────────────────────
export const githubRedirect = (req: Request, res: Response) => {
    const url = "https://github.com/login/oauth/authorize?" +
        new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            redirect_uri: GITHUB_CALLBACK_URL,
            scope: "read:user user:email",
        })
    res.redirect(url)
}

// installation handler
export const githubInstall = (req: Request, res: Response) => {
    const url = `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`
    res.redirect(url)
}

// ── Step 2: callback handler (GitHub sends back ?code=) ───
export const githubCallback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code, installation_id } = req.query;
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

        const { access_token, refresh_token } = tokenResponse.data;

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
                githubInstallationId: installation_id ? String(installation_id) : undefined,
            },
            create: {
                email: email,
                avatar: avatar_url,
                name: login,
                githubId: String(githubId),
                githubInstallationId: installation_id ? String(installation_id) : undefined,
            }
        });

        // 6. store tokens in session
        setAuthSession(req, access_token, user.id, refresh_token);
        res.json({ message: "Successfully authenticated" });

    } catch (error) {
        console.error("GitHub callback error:", error);
        next(error);
    }
}

