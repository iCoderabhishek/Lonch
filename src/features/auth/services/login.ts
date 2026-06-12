import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../../shared/libs/prisma";
import { ApiError } from "../../../shared/libs/error";
import bcrypt from "bcryptjs";
import { issueTokens } from "../utils/token";

const login = async (req: Request, res: Response, next: NextFunction) => {
    const { email, password } = req.body
    if (!email || !password) {
        return next(ApiError.badRequest("Invalid email or password"))
    }

    const user = await prisma.user.findUnique({
        where: {
            email
        }
    });
    if (!user) {
        return next(ApiError.notFound("User not found"))
    }

    const isPasswordValid = await bcrypt.compare(password, user.password || "")
    if (!isPasswordValid) {
        return next(ApiError.unauthorized("Invalid email or password"))
    }

    const { accessToken } = await issueTokens(user.id, res)
    res.json({ accessToken });

};

export default login
