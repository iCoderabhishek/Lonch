import { type Request, type Response } from "express";
import { prisma } from "../../shared/libs/prisma";
import dns from "dns";
import { promisify } from "util";
import { requestCertificate, getCertificateStatus, attachCertificateToAlb } from "../../shared/services/acm-service";
import { PROXY_IP, DEPLOYMENT_DOMAIN } from "../../shared/libs/env-lib";

const resolveCname = promisify(dns.resolveCname);
const resolve4 = promisify(dns.resolve4);

export const verifyCustomDomain = async (req: Request, res: Response) => {
    try {
        const slug = req.params.slug as string;
        // @ts-ignore
        const userId = req.user?.id; 

        const project = await prisma.project.findUnique({ where: { slug } });

        if (!project) return res.status(404).json({ error: "Project not found" });
        if (project.ownerId !== userId) return res.status(403).json({ error: "Unauthorized" });
        if (!project.customDomain) return res.status(400).json({ error: "No custom domain set" });

        const domain = project.customDomain;
        let dnsValid = false;

        // Check DNS
        try {
            const isApex = domain.split('.').length === 2; // simple check for root domains
            
            // First check A records since it's the most definitive for apex, but subdomains can use it too
            const aRecords = await resolve4(domain).catch(() => [] as string[]);
            if (aRecords.includes(PROXY_IP)) {
                dnsValid = true;
            } else if (!isApex) {
                // If it's a subdomain and A record didn't match, check CNAME
                const cnames = await resolveCname(domain).catch(() => [] as string[]);
                if (cnames.some(c => c.includes(DEPLOYMENT_DOMAIN) || c.includes("amazonaws.com") || c.includes("localhost"))) {
                    dnsValid = true;
                }
            }
        } catch (e) {
            // DNS resolution failed entirely
            dnsValid = false;
        }

        // Check ACM
        let acmArn = project.acmCertificateArn;
        let sslStatus = "UNPROVISIONED";
        let validationRecord = null;

        if (!acmArn) {
            try {
                acmArn = await requestCertificate(domain);
                await prisma.project.update({
                    where: { id: project.id },
                    data: { acmCertificateArn: acmArn }
                });
                sslStatus = "REQUESTED";
            } catch (err: any) {
                console.error("Failed to request ACM certificate:", err);
                return res.status(500).json({ error: "Failed to provision SSL certificate", details: err.message });
            }
        }

        if (acmArn) {
            const certStatus = await getCertificateStatus(acmArn);
            sslStatus = certStatus.status || "UNKNOWN";
            validationRecord = certStatus.validationRecord;

            if (sslStatus === "ISSUED") {
                try {
                    await attachCertificateToAlb(acmArn);
                } catch (err: any) {
                    // Ignore DuplicateListenerCertificate errors
                    if (err.name !== "DuplicateListenerCertificateException") {
                        console.error("Failed to attach cert to ALB", err);
                    }
                }
            }
        }

        return res.status(200).json({
            domain,
            dnsValid,
            sslStatus,
            validationRecord,
            configured: dnsValid && sslStatus === "ISSUED"
        });

    } catch (error) {
        console.error("Error verifying custom domain:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};
