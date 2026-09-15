import axios from "axios"
import jwt from "jsonwebtoken"
import { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } from "../env-lib";

// the .pem is multi-line; in .env it's stored with literal "\n" — restore real newlines
const privateKey = (GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n")

// Note: RS256 (RSA) - algo used by gh - asymmetric 
const generateAppJwt = (): string => {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign(
        {
            iat: now - 60,   // 60s in the past to tolerate clock skew
            exp: now + 600,  // GitHub caps App JWTs at 10 minutes
            iss: GITHUB_APP_ID,
        },
        privateKey,
        { algorithm: "RS256" }
    )
}


// Asks GitHub directly whether our app is installed on an account, so it works
// regardless of the user's token type. Returns null when not installed (GitHub 404s).
export const getInstallationIdForAccount = async (login: string): Promise<string | null> => {
    const appJwt = generateAppJwt()

    const headers = {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "lonch",
    }

    // a login can be either a user or an org
    for (const path of [`/users/${login}/installation`, `/orgs/${login}/installation`]) {
        try {
            const { data } = await axios.get(`https://api.github.com${path}`, { headers })
            if (data?.id) return String(data.id)
        } catch (err: any) {
            if (err?.response?.status === 404) continue
            console.error(`[github] ${path} lookup failed:`, err?.response?.data || err?.message)
        }
    }

    return null
}

export const getInstallationToken = async (installationId: string): Promise<string> => {
    const appJwt = generateAppJwt()

    const { data } = await axios.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {},
        {
            headers: {
                Authorization: `Bearer ${appJwt}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "lonch",
            },
        }
    )

    return data.token as string
}
