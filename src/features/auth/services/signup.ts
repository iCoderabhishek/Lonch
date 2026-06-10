import type { Request, Response } from "express";
import { prisma } from "../../../shared/libs/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const signup = async (req: Request, res: Response) => {
    const { email, password } = req.body
    if (!email || !password) {
        return res.status(400).json({ message: "Bad request" })
    }

    const user = await prisma.user.findUnique({
        where: {
            email
        }
    });
    if (user) {
        return res.status(400).json({ message: "User already exists" })
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const createdUser = await prisma.user.create({
        data: {
            email,
            password: hashedPassword,
        }
    });

    const userId = createdUser.id as string

    const token = jwt.sign({ id: userId }, process.env.JWT_SECRET!, { expiresIn: "7d" });
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 60 * 60 * 24 * 7, //7 d
    })
    res.json({ token: token })
};

export default signup