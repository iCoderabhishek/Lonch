import { prisma } from "../../../shared/libs/prisma";
import { updateDeploymentStatus, triggerDeploy } from "../../../shared/services/deploy-service";

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

export const processGithubWebhook = async (payload: any, eventName: string) => {
    if (eventName !== "push") {
        console.log(`[GitHub Webhook] Ignoring event type: ${eventName}`);
        return;
    }

    const repoId = payload.repository?.id;
    const pushedRef = payload.ref; // e.g., 'refs/heads/main'
    const defaultBranch = payload.repository?.default_branch;

    if (!repoId || !pushedRef) {
        console.error("[GitHub Webhook] Invalid payload structure. Missing repoId or ref.");
        return;
    }

    // We only want to trigger deployments if they pushed to the default branch (e.g. main/master)
    // NOTE: If you add a "branch" field to the Project model in the future, you can check it here!
    if (pushedRef !== `refs/heads/${defaultBranch}`) {
        console.log(`[GitHub Webhook] Ignoring push to branch ${pushedRef}. Default branch is ${defaultBranch}.`);
        return;
    }

    // Find all projects in the database that are linked to this GitHub repository
    const projects = await prisma.project.findMany({
        where: { repoId: repoId }
    });

    if (projects.length === 0) {
        console.log(`[GitHub Webhook] No projects found for repo ID ${repoId}.`);
        return;
    }

    console.log(`[GitHub Webhook] Found ${projects.length} project(s) linked to repo ${repoId}. Queuing deployments...`);

    for (const project of projects) {
        if (project.disabled) {
            console.log(`[GitHub Webhook] Skipping project ${project.id} because it is disabled.`);
            continue;
        }

        try {
            await triggerDeploy(project.id);
            console.log(`[GitHub Webhook] Successfully queued deployment for project: ${project.slug}`);
        } catch (error) {
            console.error(`[GitHub Webhook] Failed to queue deployment for project ${project.id}:`, error);
        }
    }
};
