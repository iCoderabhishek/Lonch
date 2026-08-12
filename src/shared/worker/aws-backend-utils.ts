import {
    ECSClient,
    UpdateServiceCommand,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
    CreateServiceCommand,
    AssignPublicIp,
    waitUntilServicesStable
} from "@aws-sdk/client-ecs";
import {
    ECRClient,
    GetAuthorizationTokenCommand,
    DescribeRepositoriesCommand,
    CreateRepositoryCommand
} from "@aws-sdk/client-ecr";
import {
    ElasticLoadBalancingV2Client,
    CreateTargetGroupCommand,
    CreateRuleCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
    CloudWatchLogsClient,
    CreateLogGroupCommand
} from "@aws-sdk/client-cloudwatch-logs";
import {
    AWS_S3_REGION,
    AWS_ECR_REGION,
    AWS_VPC_ID,
    AWS_ALB_LISTENER_ARN,
    AWS_ECS_SUBNETS,
    AWS_ECS_SECURITY_GROUPS,
    AWS_ECS_EXECUTION_ROLE_ARN,
    AWS_ECR_REPOSITORY_URI
} from "../libs/env-lib";
import { prisma } from "../libs/prisma";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);

const ecrRegion = AWS_ECR_REPOSITORY_URI ? AWS_ECR_REPOSITORY_URI.split('.')[3] : AWS_ECR_REGION;
const ecsClient = new ECSClient({ region: ecrRegion });
const albClient = new ElasticLoadBalancingV2Client({ region: ecrRegion });
const ecrClient = new ECRClient({ region: ecrRegion });
const cloudwatchClient = new CloudWatchLogsClient({ region: ecrRegion });

export async function authenticateECR() {
    console.log(`[Worker] Authenticating with AWS ECR...`);
    const authResponse = await ecrClient.send(new GetAuthorizationTokenCommand({}));
    const authData = authResponse.authorizationData?.[0];
    if (!authData || !authData.authorizationToken) {
        throw new Error("Failed to get ECR authorization token");
    }

    const decodedAuth = Buffer.from(authData.authorizationToken, 'base64').toString('utf-8');
    const [username, password] = decodedAuth.split(':');

    const registryUrl = AWS_ECR_REPOSITORY_URI.split('/')[0];

    await new Promise<void>((resolve, reject) => {
        const { spawn } = require('child_process');
        const child = spawn('docker', ['login', '--username', username as string, '--password-stdin', registryUrl]);
        
        child.stdout.on('data', (data: Buffer) => console.log(`[Docker Login] ${data.toString().trim()}`));
        child.stderr.on('data', (data: Buffer) => console.error(`[Docker Login Error] ${data.toString().trim()}`));
        
        child.on('close', (code: number) => {
            if (code === 0) resolve();
            else reject(new Error(`Docker login failed with exit code ${code}`));
        });

        child.stdin.write(password as string);
        child.stdin.end();
    });
}

export async function ensureEcrRepositoryExists() {
    if (!AWS_ECR_REPOSITORY_URI) return;
    const repoName = AWS_ECR_REPOSITORY_URI.split('/').slice(1).join('/');
    
    try {
        await ecrClient.send(new DescribeRepositoriesCommand({ repositoryNames: [repoName] }));
    } catch (err: any) {
        if (err.name === 'RepositoryNotFoundException') {
            console.log(`[Worker] ECR Repository '${repoName}' not found. Creating it...`);
            await ecrClient.send(new CreateRepositoryCommand({ repositoryName: repoName }));
            console.log(`[Worker] ECR Repository '${repoName}' created successfully.`);
        } else {
            throw err;
        }
    }
}

async function ensureCloudwatchLogGroupExists(slug: string) {
    const logGroupName = `/ecs/lonch-${slug}`;
    try {
        await cloudwatchClient.send(new CreateLogGroupCommand({ logGroupName }));
        console.log(`[Worker] Created CloudWatch Log Group: ${logGroupName}`);
    } catch (err: any) {
        if (err.name === 'ResourceAlreadyExistsException') {
            // Already exists, ignore
        } else {
            console.error(`[Worker Warning] Failed to pre-create log group ${logGroupName}:`, err.message);
        }
    }
}

function checkEnvVar(project: any, appPort: number) {
    // im filling up the env var for ports, coz many developers forget to add port env var in there project but their envs
    const awsEnvVars = project.envVars.map((envVar: any) => ({
        name: envVar.key,
        value: envVar.value
    }));

    if (!awsEnvVars.some((e: any) => e.name === "PORT")) {
        awsEnvVars.push({ name: "PORT", value: appPort.toString() });
    }
    return awsEnvVars;
}

export async function provisionNewEcsService(project: any, imageTag: string, appPort: number): Promise<string> {

    console.log(`[Worker] No ECS Service found for project. Provisioning new ALB Target Group and ECS Service...`);

    const envs = checkEnvVar(project, appPort)

    await ensureCloudwatchLogGroupExists(project.slug);

    // 1. Create Target Group in ALB
    const tgResponse = await albClient.send(new CreateTargetGroupCommand({
        Name: `tg-lonch-${project.slug.substring(0, 16)}`,
        Protocol: "HTTP",
        Port: appPort,
        VpcId: AWS_VPC_ID,
        TargetType: "ip",
        HealthCheckPath: "/",
        HealthCheckIntervalSeconds: 30,
        Matcher: { HttpCode: "200-499" }
    }));
    const targetGroupArn = tgResponse.TargetGroups?.[0]?.TargetGroupArn;
    if (!targetGroupArn) throw new Error("Failed to create ALB Target Group");

    // 2. Create Listener Rule
    const rulePriority = Math.floor(Math.random() * 49999) + 1;
    await albClient.send(new CreateRuleCommand({
        ListenerArn: AWS_ALB_LISTENER_ARN,
        Priority: rulePriority,
        Conditions: [
            {
                Field: "host-header",
                HostHeaderConfig: {
                    Values: [`${project.slug}.lonch.cloud`, `${project.slug}.localhost`]
                }
            }
        ],
        Actions: [
            {
                Type: "forward",
                TargetGroupArn: targetGroupArn
            }
        ]
    }));

    // 3. Register Task Definition
    const taskDefResponse = await ecsClient.send(new RegisterTaskDefinitionCommand({
        family: `task-lonch-${project.slug}`,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: (project.maxCpu ? project.maxCpu * 256 : 256).toString(),
        memory: (project.maxMemory ? Math.floor(project.maxMemory / 1048576) : 512).toString(),
        executionRoleArn: AWS_ECS_EXECUTION_ROLE_ARN,
        containerDefinitions: [
            {
                name: `app-${project.slug}`,
                image: imageTag,
                portMappings: [{ containerPort: appPort, protocol: "tcp" }],
                environment: envs,
                essential: true,
                logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                        "awslogs-group": `/ecs/lonch-${project.slug}`,
                        "awslogs-region": ecrRegion as string,
                        "awslogs-stream-prefix": "ecs"
                    }
                }
            }
        ]
    }));

    // The task definition response looks like:
    // {
    //   "taskDefinition": {
    //     "taskDefinitionArn": "arn:aws:ecs:ap-south-1:123456789012:task-definition/lonch-backend:2",
    //     "containerDefinitions": [
    //       {
    //         "name": "lonch-backend",
    //         "image": "123456789012.dkr.ecr.ap-south-1.amazonaws.com/lonch-backend:v1",
    //         "cpu": 0,
    //         "memory": null,
    //         "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
    //         "essential": true
    //       }
    //     ],
    //     "family": "lonch-backend",
    //     "status": "ACTIVE",
    //     "revision": 1,
    //     "nodeRole": "arn:aws:iam::123456789012:role/lonch-ecs-task-role",
    //     "compatibilities": ["FARGATE"],
    //     "cpu": "1024",
    //     "memory": "4096",
    //     "networkMode": "awsvpc",
    //     "requiresAttributes": [
    //       {"name": "com.amazonaws.ecs.capability.ecr-auth"},
    //       {"name": "com.amazonaws.ecs.capability.execution-role-ecr-pull"}
    //     ],
    //     "registeredAt": "2022-12-01T05:12:34.567Z",
    //     "registeredBy": "arn:aws:iam::123456789012:user/lonch-admin"
    //   }
    // }

    const taskDefArn = taskDefResponse.taskDefinition?.taskDefinitionArn;
    if (!taskDefArn) throw new Error("Failed to register task definition");

    // 4. Create ECS Service
    const subnets = AWS_ECS_SUBNETS.split(",").map(s => s.trim());
    const securityGroups = AWS_ECS_SECURITY_GROUPS.split(",").map(s => s.trim());

    const createServiceRes = await ecsClient.send(new CreateServiceCommand({
        cluster: "lonch-production-cluster",
        serviceName: `svc-lonch-${project.slug}`,
        taskDefinition: taskDefArn,
        desiredCount: 1,
        launchType: "FARGATE",
        networkConfiguration: {
            awsvpcConfiguration: {
                subnets,
                securityGroups,
                assignPublicIp: AssignPublicIp.ENABLED
            }
        },
        loadBalancers: [
            {
                targetGroupArn: targetGroupArn,
                containerName: `app-${project.slug}`,
                containerPort: appPort
            }
        ]
    }));

    const newServiceArn = createServiceRes.service?.serviceArn;
    if (!newServiceArn) throw new Error("Failed to create ECS Service");

    // Update Project in DB
    await prisma.project.update({
        where: { id: project.id },
        data: { ecsServiceArn: newServiceArn }
    });

    console.log(`[Worker] Successfully provisioned new ECS Service: ${newServiceArn}`);
    return newServiceArn;
}

export async function updateExistingEcsService(project: any, imageTag: string, appPort: number): Promise<void> {
    console.log(`[Worker] Updating existing ECS service...`);


    // code duplication

    const envVar = checkEnvVar(project, appPort);

    await ensureCloudwatchLogGroupExists(project.slug);

    const describeServiceResponse = await ecsClient.send(new DescribeServicesCommand({
        cluster: "lonch-production-cluster",
        services: [project.ecsServiceArn],
    }));

    const activeTaskDefArn = describeServiceResponse.services?.[0]?.taskDefinition;
    if (!activeTaskDefArn) {
        throw new Error("Could not find active Task Definition for service.");
    }

    const describeTaskDefResponse = await ecsClient.send(new DescribeTaskDefinitionCommand({
        taskDefinition: activeTaskDefArn,
    }));

    const taskDef = describeTaskDefResponse.taskDefinition;
    if (!taskDef || !taskDef.containerDefinitions || taskDef.containerDefinitions.length === 0) {
        throw new Error("Invalid Task Definition structure returned from AWS.");
    }

    const primaryContainer = taskDef.containerDefinitions[0];
    if (!primaryContainer) {
        throw new Error("No container definitions found in the Task Definition.");
    }

    primaryContainer.environment = envVar;
    primaryContainer.image = imageTag;
    primaryContainer.portMappings = [
        {
            containerPort: appPort,
            hostPort: appPort,
            protocol: "tcp"
        }
    ];

    const registerResponse = await ecsClient.send(new RegisterTaskDefinitionCommand({
        family: taskDef.family!,
        containerDefinitions: taskDef.containerDefinitions,
        executionRoleArn: taskDef.executionRoleArn,
        taskRoleArn: taskDef.taskRoleArn,
        networkMode: taskDef.networkMode,
        requiresCompatibilities: taskDef.requiresCompatibilities,
        cpu: taskDef.cpu,
        memory: taskDef.memory,
    }));

    const newTaskDefArn = registerResponse.taskDefinition?.taskDefinitionArn;
    if (!newTaskDefArn) {
        throw new Error("Failed to register new Task Definition revision.");
    }

    await ecsClient.send(
        new UpdateServiceCommand({
            cluster: "lonch-production-cluster",
            service: project.ecsServiceArn,
            taskDefinition: newTaskDefArn,
            forceNewDeployment: true,
        })
    );
}

export async function waitForEcsService(project: any) {
    console.log(`[Worker] Waiting for ECS service to reach steady state (this usually takes 2-4 minutes)...`);
    await waitUntilServicesStable(
        { client: ecsClient, maxWaitTime: 600 },
        { cluster: "lonch-production-cluster", services: [project.ecsServiceArn] }
    );
    console.log(`[Worker] ECS service is now completely stable and running!`);
}
