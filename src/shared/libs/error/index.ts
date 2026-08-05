export class ApiError extends Error {
    public readonly statusCode: number;
    public readonly isOperational: boolean;
    public readonly details?: any;

    constructor(
        statusCode: number,
        message: string,
        isOperational = true,
        details?: any,
        stack = ""
    ) {
        super(message);
        
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.details = details;

        if (stack) {
            this.stack = stack;
        } else {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    // Quick helpers for common errors
    static badRequest(message: string, details?: any) {
        return new ApiError(400, message, true, details);
    }

    static unauthorized(message: string = "Unauthorized") {
        return new ApiError(401, message);
    }

    static forbidden(message: string = "Forbidden") {
        return new ApiError(403, message);
    }

    static notFound(message: string = "Not found") {
        return new ApiError(404, message);
    }

    static internal(message: string = "Internal Server Error") {
        return new ApiError(500, message, false);
    }
}

import type { Request, Response, NextFunction } from "express";

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ApiError) {
        return res.status(err.statusCode).json({
            error: {
                message: err.message,
                details: err.details,
            }
        });
    }

    // For unhandled, non-ApiError exceptions (e.g. native errors)
    console.error("Unhandled Error:", err);
    return res.status(500).json({
        error: {
            message: "Internal Server Error"
        }
    });
};
