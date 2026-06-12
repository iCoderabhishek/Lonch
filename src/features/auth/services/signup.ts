import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../../shared/libs/prisma";
import { ApiError } from "../../../shared/libs/error";
import bcrypt from "bcryptjs";
import { issueTokens } from "../utils/token";

const signup = async (req: Request, res: Response, next: NextFunction) => {
    const { email, password } = req.body
    if (!email || !password) {
        return next(ApiError.badRequest("Bad request"))
    }

    const user = await prisma.user.findUnique({
        where: {
            email
        }
    });
    if (user) {
        return next(ApiError.badRequest("User already exists"))
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const createdUser = await prisma.user.create({
        data: {
            email,
            password: hashedPassword,
        }
    });

    const { accessToken } = await issueTokens(createdUser.id, res)
    res.json({ accessToken })
};

export default signup
