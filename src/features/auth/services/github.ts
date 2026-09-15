import type { Request, Response, NextFunction } from "express"
import axios from "axios"
import { ApiError } from "../../../shared/libs/error"
import { prisma } from "../../../shared/libs/prisma"
import { setAuthSession } from "../utils/token"
import { getInstallationIdForAccount } from "../../../shared/libs/github"
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL, GITHUB_APP_NAME, FRONTEND_URL } from "../../../shared/libs/env-lib";

const INSTALL_URL = () => `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`

const buildAuthorizeUrl = (state?: string) => {
    const params: Record<string, string> = {
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: GITHUB_CALLBACK_URL,
        scope: "read:user user:email",
    }
    if (state) params.state = state

    return "https://github.com/login/oauth/authorize?" + new URLSearchParams(params)
}

// ── Step 1: redirect handler ──────────────────────────────
export const githubRedirect = (req: Request, res: Response) => {
    res.redirect(buildAuthorizeUrl())
}

// installation handler
export const githubInstall = (req: Request, res: Response) => {
    res.redirect(INSTALL_URL())
}

// ── Step 2: callback handler (GitHub sends back ?code=) ───
export const githubCallback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code, installation_id, setup_action } = req.query;

        // The setup URL redirect carries installation_id but no code, so send the user
        // through OAuth to get a token. state marks the hop to prevent a redirect loop.
        if (!code) {
            if (installation_id || setup_action) {
                return res.redirect(buildAuthorizeUrl("post_install"));
            }
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

        // ── 5. resolve the app installation ───────────────────────────
        let finalInstallationId: string | undefined;

        // only works if GITHUB_CLIENT_ID is the GitHub App's client id, not an OAuth App's
        try {
            const installationsResponse = await axios.get("https://api.github.com/user/installations", {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "lonch"
                }
            });
            const installations = installationsResponse.data?.installations ?? [];
            const own = installations.find((i: any) => String(i.account?.id) === String(githubId));
            const chosen = own ?? installations[0];
            if (chosen?.id) finalInstallationId = String(chosen.id);
        } catch (err: any) {
            console.warn(
                "[auth] /user/installations lookup failed (is GITHUB_CLIENT_ID the GitHub App's client id?):",
                err?.response?.status,
                err?.response?.data?.message || err?.message
            );
        }

        if (!finalInstallationId) {
            finalInstallationId = (await getInstallationIdForAccount(login)) ?? undefined;
        }

        // GitHub documents installation_id as spoofable, so trust it only as a last resort
        if (!finalInstallationId && installation_id) {
            console.warn("[auth] falling back to unverified installation_id query param");
            finalInstallationId = String(installation_id);
        }

        // ── 6. no installation, no account ────────────────────────────
        if (!finalInstallationId) {
            const alreadyTried = req.query.state === "post_install";

            console.warn(
                `[auth] no GitHub App installation for ${login} — refusing to create user;` +
                (alreadyTried ? " install did not complete" : " redirecting to install")
            );

            // already been through install and still nothing: cancelled, or pending org approval
            if (alreadyTried) {
                return res.redirect(`${FRONTEND_URL}/login?error=installation_required`);
            }

            return res.redirect(INSTALL_URL());
        }

        // githubInstallationId is @unique, so detach any stale owner or the upsert throws P2002
        await prisma.user.updateMany({
            where: {
                githubInstallationId: finalInstallationId,
                githubId: { not: String(githubId) }
            },
            data: { githubInstallationId: null }
        });

        // 7. upsert the user
        const user = await prisma.user.upsert({
            where: {
                githubId: String(githubId)
            },
            update: {
                email: email,
                avatar: avatar_url,
                name: login,
                githubInstallationId: finalInstallationId,
            },
            create: {
                email: email,
                avatar: avatar_url,
                name: login,
                githubId: String(githubId),
                githubInstallationId: finalInstallationId,
            }
        });

        // 8. store tokens in session
        setAuthSession(req, access_token, user.id, refresh_token);
        res.redirect(`${FRONTEND_URL}/dashboard`);

    } catch (error) {
        console.error("GitHub callback error:", error);
        next(error);
    }
}

