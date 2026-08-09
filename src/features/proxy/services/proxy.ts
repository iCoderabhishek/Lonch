import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../../shared/libs/prisma";
import { s3 } from "../../../shared/libs/s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { AWS_S3_BUCKET_NAME } from "../../../shared/libs/env-lib";
import mime from "mime-types";
import { createProxyMiddleware } from "http-proxy-middleware";
import { getLiveContainerIp } from "./ecs-discovery";

export const proxyRequest = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const host = req.hostname;
        let slug = "";

        if (host.endsWith(".lonch.0bhishek.com")) {
            slug = host.replace(".lonch.0bhishek.com", "");
        } else if (host.endsWith(".localhost")) {
            slug = host.replace(".localhost", "");
        }

        if (!slug) {
            console.log(`[Proxy] Invalid subdomain for host: ${host}`);
            return res.status(400).send("Invalid subdomain");
        }

        console.log(`[Proxy] Incoming request for host: ${host} | Extracted slug: ${slug} | File: ${req.path}`);

        const project = await prisma.project.findFirst({
            where: { slug },
            include: { owner: true }
        });

        if (!project) {
            return res.status(404).send("Project not found");
        }

        if (project.type === "BACKEND") {
            if (!project.ecsServiceArn) {
                return res.status(500).send("Backend service not properly configured");
            }
            
            // ecsServiceArn typically looks like: arn:aws:ecs:region:account:service/clusterName/serviceName
            const arnParts = project.ecsServiceArn.split(":");
            const resourcePart = arnParts[5]; // service/clusterName/serviceName
            if (!resourcePart) {
                return res.status(500).send("Invalid ECS Service ARN format");
            }
            const parts = resourcePart.split("/");
            if (parts.length < 3) {
                return res.status(500).send("Invalid ECS Service ARN format");
            }
            const clusterName = parts[1]!;
            const serviceName = parts[2]!;

            const ip = await getLiveContainerIp(clusterName, serviceName);
            if (!ip) {
                return res.status(502).send("Bad Gateway: Container is down or IP could not be discovered.");
            }

            const target = `http://${ip}:${project.port || 3000}`;
            console.log(`[Proxy] Forwarding ${slug} to ECS IP -> ${target}`);
            
            const proxy = createProxyMiddleware({
                target,
                changeOrigin: true,
                ws: true, // Support websocket upgrades
            });

            return proxy(req, res, next);
        }

        // --- STATIC PROJECT LOGIC ---
        let filePath = req.path;
        if (!filePath || filePath === "/") {
            filePath = "/index.html";
        }
        filePath = filePath.replace(/^\/+/, "");

        const deployment = await prisma.deployment.findFirst({
            where: { projectId: project.id, status: "SUCCESS" },
            orderBy: { createdAt: "desc" }
        });

        if (!deployment || !deployment.staticS3Key) {
            return res.status(404).send("No successful deployment found for this project");
        }

        const s3Key = `${deployment.staticS3Key}/${filePath}`;

        const command = new GetObjectCommand({
            Bucket: AWS_S3_BUCKET_NAME!,
            Key: s3Key,
        });

        const s3Item = await s3.send(command);

        if (!s3Item.Body) {
            return res.status(404).send("File body is empty");
        }

        const contentType = mime.lookup(filePath) || "application/octet-stream";
        res.setHeader("Content-Type", contentType);

        // Pipe the S3 stream directly to the express response
        (s3Item.Body as NodeJS.ReadableStream).pipe(res);

    } catch (error: any) {
        if (error.name === "NoSuchKey") {
            return res.status(404).send("File not found");
        }
        console.error("Proxy error:", error);
        res.status(500).send("Internal server error");
    }
};
