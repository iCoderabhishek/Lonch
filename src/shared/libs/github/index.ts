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
