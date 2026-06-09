import type { Request, Response } from "express";

const signup = (req: Request, res: Response) => {
    const { email, password } = req.body
    if (!email || !password) {
        return res.status(400).json({ message: "Bad request" })
    }

    return res.json({ message: "ok" })
};

export default signup