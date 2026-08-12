import { Worker } from "bullmq";
import { REDIS_URL, AWS_ALB_LISTENER_ARN, AWS_S3_BUCKET_NAME } from "../libs/env-lib";
import {
    ECSClient,
    DeleteServiceCommand,
    UpdateServiceCommand
} from "@aws-sdk/client-ecs";
import {
    ElasticLoadBalancingV2Client,
    DescribeTargetGroupsCommand,
    DeleteTargetGroupCommand,
    DescribeRulesCommand,
    DeleteRuleCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
    CloudWatchLogsClient,
    DeleteLogGroupCommand
} from "@aws-sdk/client-cloudwatch-logs";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { s3 } from "../libs/s3";
import { AWS_ECR_REPOSITORY_URI, AWS_ECR_REGION } from "../libs/env-lib";
import { prisma } from "../libs/prisma";

const ecrRegion = AWS_ECR_REPOSITORY_URI ? AWS_ECR_REPOSITORY_URI.split('.')[3] : AWS_ECR_REGION;
const ecsClient = new ECSClient({ region: ecrRegion });
const albClient = new ElasticLoadBalancingV2Client({ region: ecrRegion });
const cloudwatchClient = new CloudWatchLogsClient({ region: ecrRegion });

export const teardownWorker = new Worker(
    "teardown-build",
    async (job) => {
        const { projectId, slug, type, ecsServiceArn } = job.data;
        console.log(`[Teardown Worker] Starting teardown for project ${slug} (${projectId})`);

        if (type === "STATIC") {
            try {
                // Delete S3 folder
                const prefix = `projects/${projectId}/`;
                console.log(`[Teardown Worker] Deleting S3 objects with prefix: ${prefix}`);
                
                let isTruncated = true;
                let continuationToken = undefined;

                while (isTruncated) {
                    const listRes: any = await s3.send(new ListObjectsV2Command({
                        Bucket: AWS_S3_BUCKET_NAME,
                        Prefix: prefix,
                        ContinuationToken: continuationToken
                    }));

                    if (listRes.Contents && listRes.Contents.length > 0) {
                        const deletePromises = listRes.Contents.map((obj: any) => 
                            s3.send(new DeleteObjectCommand({
                                Bucket: AWS_S3_BUCKET_NAME,
                                Key: obj.Key
                            }))
                        );
                        await Promise.all(deletePromises);
                        console.log(`[Teardown Worker] Deleted ${listRes.Contents.length} objects from S3.`);
                    }

                    isTruncated = listRes.IsTruncated ?? false;
                    continuationToken = listRes.NextContinuationToken;
                }
            } catch (err: any) {
                console.error(`[Teardown Worker] Error deleting S3 objects:`, err.message);
            }
        } else if (type === "BACKEND") {
            // 1. Delete ECS Service
            if (ecsServiceArn) {
                try {
                    console.log(`[Teardown Worker] Scaling ECS service to 0 and deleting...`);
                    // Must scale to 0 before deleting
                    await ecsClient.send(new UpdateServiceCommand({
                        cluster: "lonch-production-cluster",
                        service: ecsServiceArn,
                        desiredCount: 0
                    }));
                    
                    await ecsClient.send(new DeleteServiceCommand({
                        cluster: "lonch-production-cluster",
                        service: ecsServiceArn,
                        force: true
                    }));
                    console.log(`[Teardown Worker] ECS Service deleted.`);
                } catch (err: any) {
                    console.error(`[Teardown Worker] Error deleting ECS Service:`, err.message);
                }
            }

            // 2. Delete ALB Target Group & Rule
            const targetGroupName = `tg-lonch-${slug.substring(0, 16)}`;
            let targetGroupArn = "";
            try {
                const tgRes = await albClient.send(new DescribeTargetGroupsCommand({
                    Names: [targetGroupName]
                }));
                targetGroupArn = tgRes.TargetGroups?.[0]?.TargetGroupArn || "";
            } catch (err: any) {
                console.log(`[Teardown Worker] Target group ${targetGroupName} not found or already deleted.`);
            }

            if (targetGroupArn) {
                try {
                    // Find listener rule associated with this target group
                    const rulesRes = await albClient.send(new DescribeRulesCommand({
                        ListenerArn: AWS_ALB_LISTENER_ARN
                    }));
                    
                    const ruleToDelete = rulesRes.Rules?.find(rule => 
                        rule.Actions?.some(action => action.TargetGroupArn === targetGroupArn)
                    );

                    if (ruleToDelete && ruleToDelete.RuleArn) {
                        console.log(`[Teardown Worker] Deleting ALB Listener Rule...`);
                        await albClient.send(new DeleteRuleCommand({
                            RuleArn: ruleToDelete.RuleArn
                        }));
                    }

                    console.log(`[Teardown Worker] Deleting Target Group...`);
                    await albClient.send(new DeleteTargetGroupCommand({
                        TargetGroupArn: targetGroupArn
                    }));
                } catch (err: any) {
                    console.error(`[Teardown Worker] Error deleting ALB resources:`, err.message);
                }
            }

            // 3. Delete CloudWatch Log Group
            try {
                const logGroupName = `/ecs/lonch-${slug}`;
                console.log(`[Teardown Worker] Deleting CloudWatch Log Group: ${logGroupName}`);
                await cloudwatchClient.send(new DeleteLogGroupCommand({
                    logGroupName
                }));
            } catch (err: any) {
                console.error(`[Teardown Worker] Error deleting CloudWatch Logs:`, err.message);
            }
        }
        
        console.log(`[Teardown Worker] Teardown complete for project ${slug}.`);
        
        // 4. Finally, fully delete the project from the database
        try {
            await prisma.project.delete({
                where: { id: projectId }
            });
            console.log(`[Teardown Worker] Project ${slug} fully deleted from database.`);
        } catch (err: any) {
            console.error(`[Teardown Worker] Error deleting project from database:`, err.message);
        }
    },
    { connection: { url: REDIS_URL } }
);

teardownWorker.on("error", (err) => {
    console.error("[Teardown Worker Error]:", err);
});
