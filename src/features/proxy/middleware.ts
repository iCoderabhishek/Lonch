import type { Request, Response, NextFunction } from "express";
import { proxyRequest } from "./services/proxy";

export const proxyInterceptor = (req: Request, res: Response, next: NextFunction) => {
    const host = req.hostname;
    if (host === "api.lonch.0bhishek.com" || host === "api.localhost") {
        return next();
    }

    if (host.endsWith(".lonch.0bhishek.com") || host.endsWith(".localhost")) {
        return proxyRequest(req, res, next);
    }

    next();
};
