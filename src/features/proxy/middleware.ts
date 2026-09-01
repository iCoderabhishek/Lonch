import type { Request, Response, NextFunction } from "express";
import { proxyRequest } from "./services/proxy";
import { DEPLOYMENT_DOMAIN } from "../../shared/libs/env-lib";


export const proxyInterceptor = (req: Request, res: Response, next: NextFunction) => {
    const host = req.hostname;
    // Core domains that should bypass the proxy
    if (host === DEPLOYMENT_DOMAIN || host === `api.${DEPLOYMENT_DOMAIN}` || host === "api.lonch.cloud" || host === "app" || host === "api.localhost" || host === "localhost" || host === "lonch-fe-abhishek.loca.lt") {
        return next();
    }

    // Anything else is treated as a project request (subdomain or custom domain)
    return proxyRequest(req, res, next);
};
