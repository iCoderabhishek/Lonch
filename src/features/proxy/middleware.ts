import type { Request, Response, NextFunction } from "express";
import { proxyRequest } from "./services/proxy";

export const proxyInterceptor = (req: Request, res: Response, next: NextFunction) => {
    const host = req.hostname;
    // Core domains that should bypass the proxy
    if (host === "api.lonch.0bhishek.com" || host === "api.localhost" || host === "localhost" || host === "lonch-fe-abhishek.loca.lt") {
        return next();
    }

    // Anything else is treated as a project request (subdomain or custom domain)
    return proxyRequest(req, res, next);
};
