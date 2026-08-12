import type { Request } from "express"
declare global {
    namespace Express {
        interface Request {
            user?: any,
            userId?: any,
            membership?: any,
        }
    }
}