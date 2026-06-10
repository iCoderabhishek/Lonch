import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken"
import { ApiError } from "../../../shared/libs/error";

export const middleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const JWT_SECRET = process.env.JWT_SECRET!
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(ApiError.unauthorized("Unauthorized"));
    }

    const token = authHeader.split(' ')[1] as string;

    try {
        const decoded = jwt.verify(token, JWT_SECRET)
        req.user = decoded;
        next();
    } catch (error) {
        return next(ApiError.unauthorized("Invalid or expired token"));
    }
}