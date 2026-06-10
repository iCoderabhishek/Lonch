import type { Request, Response } from "express"
import { prisma } from "../../../shared/libs/prisma";
import { ApiError } from "../../../shared/libs/error";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken"

const login = async (req: Request, res: Response) => {
    const { email, password } = req.body
    if (!email || !password) {
        return ApiError.badRequest("Invalid email or password")
    }

    const user = await prisma.user.findUnique({
        where: {
            email
        }
    });
    if (!user) {
        return res.status(404).json({ message: "User not found" })
    }

    const isPasswordValid = await bcrypt.compare(password, user?.password || "")
    if (!isPasswordValid) {
        return ApiError.unauthorized("Invalid email or password")
    }
    const userId = user.id as string

    const token = jwt.sign({ id: userId }, process.env.JWT_SECRET!, { expiresIn: "7d" });
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 60 * 60 * 24 * 7, //7 d
    })
    res.json({ token: token });

};

export default login