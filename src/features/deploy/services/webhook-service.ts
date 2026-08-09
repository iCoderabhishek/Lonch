import { prisma } from "../../../shared/libs/prisma";
import { updateDeploymentStatus } from "../../../shared/services/deploy-service";

export const processAwsEcsWebhook = async (payload: any) => {
    // We only care about ECS events
    if (payload.source !== "aws.ecs") return;

    // Check if it's a deployment state change
    if (payload["detail-type"] === "ECS Deployment State Change") {
        const detail = payload.detail;
        if (!detail) return;

        const eventName = detail.eventName;
        const serviceName = detail.serviceName;

        if (!serviceName) return;

        // Find the project associated with this service name
        // ecsServiceArn typically looks like: arn:aws:ecs:region:account:service/clusterName/serviceName
        // so we can search for a project whose ecsServiceArn ends with the serviceName
        const projects = await prisma.project.findMany({
            where: {
                ecsServiceArn: {
                    endsWith: `/${serviceName}`
                }
            }
        });

        const project = projects[0];
        if (!project) {
            console.log(`[Webhook] No project found for service: ${serviceName}`);
            return;
        }

        // Find the most recent DEPLOYING deployment for this project
        const latestDeployment = await prisma.deployment.findFirst({
            where: {
                projectId: project.id,
                status: "DEPLOYING"
            },
            orderBy: {
                createdAt: "desc"
            }
        });

        if (!latestDeployment) {
            console.log(`[Webhook] No active deployment found for project: ${project.id}`);
            return;
        }

        if (eventName === "SERVICE_DEPLOYMENT_COMPLETED") {
            console.log(`[Webhook] Deployment ${latestDeployment.id} completed successfully.`);
            await updateDeploymentStatus(latestDeployment.id, "SUCCESS");
        } else if (eventName === "SERVICE_DEPLOYMENT_FAILED") {
            console.error(`[Webhook] Deployment ${latestDeployment.id} failed.`);
            await updateDeploymentStatus(latestDeployment.id, "FAILED");

            // Log the AWS failure reason so the user can see why their deployment failed
            if (detail.reason) {
                await prisma.deploymentLog.create({
                    data: {
                        deploymentId: latestDeployment.id,
                        line: `[AWS ECS ERROR] ${detail.reason}`,
                        stream: "stderr"
                    }
                });
            }
        }
    }
};
