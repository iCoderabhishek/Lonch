import { ECSClient, ListTasksCommand, DescribeTasksCommand, DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { AWS_S3_REGION, AWS_S3_ACCESS_KEY_ID, AWS_S3_SECRET_ACCESS_KEY } from "../../../shared/libs/env-lib";
import { prisma } from "../../../shared/libs/prisma";
import type { Request, Response, NextFunction } from "express";

const awsConfig = {
    region: AWS_S3_REGION,
    credentials: {
        accessKeyId: AWS_S3_ACCESS_KEY_ID,
        secretAccessKey: AWS_S3_SECRET_ACCESS_KEY
    }
};

const ecsClient = new ECSClient(awsConfig);
const cloudWatchClient = new CloudWatchLogsClient(awsConfig);

export const getRuntimeLogs = async (req: Request, res: Response, next: NextFunction) => {
    const projectId = req.params.projectId as string;

    try {
        const project = await prisma.project.findFirst({ 
            where: { 
                id: projectId,
                ownerId: req.user.userId,
                disabled: false
            } 
        });
        if (!project || !project.ecsServiceArn) {
            return res.status(404).json({ error: "Project not found or not deployed" });
        }

        // 1. Get running tasks for the service
        const listTasksResponse = await ecsClient.send(new ListTasksCommand({
            cluster: "lonch-production-cluster",
            serviceName: project.ecsServiceArn,
            desiredStatus: "RUNNING",
        }));

        const taskArns = listTasksResponse.taskArns;
        if (!taskArns || taskArns.length === 0) {
            return res.status(404).json({ error: "No running tasks found for this project" });
        }

        const taskArn = taskArns[0]; // Just get the first running task
        if (!taskArn) {
            return res.status(404).json({ error: "Running task ARN is undefined" });
        }

        const taskId = taskArn.split('/').pop();

        // 2. Get task details to find task definition and container name
        const describeTasksResponse = await ecsClient.send(new DescribeTasksCommand({
            cluster: "lonch-production-cluster",
            tasks: [taskArn],
        }));

        const task = describeTasksResponse.tasks?.[0];
        if (!task || !task.taskDefinitionArn) {
            return res.status(500).json({ error: "Could not describe task" });
        }

        // 3. Get Task Definition to find log configuration
        const describeTaskDefResponse = await ecsClient.send(new DescribeTaskDefinitionCommand({
            taskDefinition: task.taskDefinitionArn,
        }));

        const containerDef = describeTaskDefResponse.taskDefinition?.containerDefinitions?.[0];
        if (!containerDef || !containerDef.logConfiguration || !containerDef.logConfiguration.options) {
            return res.status(500).json({ error: "No log configuration found in task definition" });
        }

        const logGroup = containerDef.logConfiguration.options["awslogs-group"];
        const streamPrefix = containerDef.logConfiguration.options["awslogs-stream-prefix"];
        const containerName = containerDef.name;

        if (!logGroup || !streamPrefix || !containerName) {
            return res.status(500).json({ error: "Incomplete log configuration" });
        }

        const logStreamName = `${streamPrefix}/${containerName}/${taskId}`;

        // SSE setup
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        let nextToken: string | undefined = undefined;
        let isConnectionClosed = false;

        req.on("close", () => {
            isConnectionClosed = true;
        });


        // we can configure AWS to forward all CloudWatch logs to an AWS Lambda function, which then pushes them to our Redis server. This provides 0-second delay, but it is extremely complex to set up and costs much more money.

        // note -> for now we are polling every 3 seconds, which is not real-time but it is good enough for our use case.
        while (!isConnectionClosed) {
            try {
                const command = new GetLogEventsCommand({
                    logGroupName: logGroup,
                    logStreamName: logStreamName,
                    nextToken: nextToken,
                    startFromHead: nextToken ? false : true,
                });

                const logsResponse: any = await cloudWatchClient.send(command);

                const events = logsResponse.events || [];
                for (const event of events) {
                    if (event.message) {
                        res.write(`data: ${event.message}\n\n`);
                        // Force flush if compression middleware is used
                        if (typeof (res as any).flush === 'function') {
                            (res as any).flush();
                        }
                    }
                }

                if (events.length > 0) {
                    nextToken = logsResponse.nextForwardToken;
                }
            } catch (err: any) {
                if (err.name === 'ResourceNotFoundException') {
                    // Log stream might not be created yet, wait and retry
                } else {
                    console.error("[CloudWatch Polling Error]", err);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 3000));

            // Send heartbeat to prevent ALB 60s idle timeout drop
            res.write(':\\n\\n');
            if (typeof (res as any).flush === 'function') {
                (res as any).flush();
            }
        }

    } catch (error) {
        console.error("Error fetching app logs:", error);
        if (!res.headersSent) {
            next(error);
        }
    }
};
