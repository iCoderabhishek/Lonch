import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../../shared/libs/prisma";
import { s3 } from "../../../shared/libs/s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { AWS_S3_BUCKET_NAME, AWS_ALB_DNS_NAME, DEPLOYMENT_DOMAIN } from "../../../shared/libs/env-lib";
import mime from "mime-types";
import { createProxyMiddleware } from "http-proxy-middleware";

let albProxy: any = null;

export const proxyRequest = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const host = req.hostname;
        let slug = "";
        let isCustomDomain = false;

        if (host.endsWith(`.${DEPLOYMENT_DOMAIN}`)) {
            slug = host.replace(`.${DEPLOYMENT_DOMAIN}`, "");
        } else if (host.endsWith(".localhost")) {
            slug = host.replace(".localhost", "");
        } else {
            isCustomDomain = true;
        }

        const project = await prisma.project.findFirst({
            where: isCustomDomain ? { customDomain: host, disabled: false } : { slug, disabled: false },
            include: { owner: true }
        });

        // Expanded list of common bot scan paths to keep your logs clean
        const isBotScan = req.path.includes('.env') || req.path.includes('.php') || req.path.includes('.json') || req.path.includes('.axd') || req.path.includes('/actuator') || req.path.includes('/.vscode') || req.path.includes('/.well-known') || /^[\d.]+$/.test(host);

        if (!project) {
            if (!isBotScan) {
                console.log(`[Proxy] 404 Project not found: ${host} | File: ${req.path}`);
            }
            return res.status(404).send("Project not found");
        }

        console.log(`[Proxy] Incoming request for host: ${host} | File: ${req.path}`);

        if (project.type === "BACKEND") {
            if (!AWS_ALB_DNS_NAME) {
                return res.status(500).send("AWS_ALB_DNS_NAME not configured on the proxy server.");
            }

            if (!albProxy) {
                albProxy = createProxyMiddleware({
                    target: `https://${AWS_ALB_DNS_NAME}`,
                    secure: false, // Must ignore SSL verification since we are calling ALB by its raw DNS instead of the ACM certificate domain
                    changeOrigin: true,
                    ws: true,
                    on: {
                        proxyReq: (proxyReq, req, res) => {
                            // Forward the original host (without port) so the ALB Listener Rule matches it exactly
                            const hostWithoutPort = (req.headers.host || '').split(':')[0] || '';
                            proxyReq.setHeader('Host', hostWithoutPort);
                        }
                    }
                });
            }

            console.log(`[Proxy] Forwarding ${slug} backend request to ALB -> ${AWS_ALB_DNS_NAME}`);
            return albProxy(req, res, next);
        }

        // --- STATIC PROJECT LOGIC ---
        let filePath = req.path;
        if (!filePath || filePath === "/") {
            filePath = "/index.html";
        } else if (filePath.endsWith("/")) {
            filePath = filePath + "index.html";
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
