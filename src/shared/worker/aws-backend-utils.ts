import {
    ECSClient,
    UpdateServiceCommand,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
    CreateServiceCommand,
    AssignPublicIp,
    waitUntilServicesStable,
    ListTasksCommand,
    DescribeTasksCommand
} from "@aws-sdk/client-ecs";
import {
    EC2Client,
    DescribeNetworkInterfacesCommand
} from "@aws-sdk/client-ec2";
import axios from "axios";
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
    AWS_ECR_REPOSITORY_URI,
    AWS_S3_ACCESS_KEY_ID,
    AWS_S3_SECRET_ACCESS_KEY,
    CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID
} from "../libs/env-lib";
import { prisma } from "../libs/prisma";
import { promisify } from "util";
import { execFile } from "child_process";
import { workerLog } from "./logger";

const execFileAsync = promisify(execFile);

const ecrRegion = AWS_ECR_REPOSITORY_URI ? AWS_ECR_REPOSITORY_URI.split('.')[3] : AWS_ECR_REGION;

const awsConfig = {
    region: ecrRegion,
    credentials: {
        accessKeyId: AWS_S3_ACCESS_KEY_ID,
        secretAccessKey: AWS_S3_SECRET_ACCESS_KEY
    }
};

const ecsClient = new ECSClient(awsConfig);
const albClient = new ElasticLoadBalancingV2Client(awsConfig);
const ecrClient = new ECRClient(awsConfig);
const cloudwatchClient = new CloudWatchLogsClient(awsConfig);
const ec2Client = new EC2Client(awsConfig);

// Helper to poll for a running task and get its Public IP (<60s)
async function getTaskPublicIp(cluster: string, serviceName: string, deploymentId: string): Promise<string> {
    await workerLog(deploymentId, "Polling for new Fargate task to reach RUNNING state...");
    
    let taskArn: string | undefined;
    for (let i = 0; i < 30; i++) { // wait up to 60s
        const listRes = await ecsClient.send(new ListTasksCommand({ cluster, serviceName }));
        if (listRes.taskArns && listRes.taskArns.length > 0) {
            taskArn = listRes.taskArns[0];
            break;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    if (!taskArn) throw new Error("No task spun up within 60 seconds");

    let eniId: string | undefined;
    for (let i = 0; i < 45; i++) { // wait up to 90s for RUNNING state
        const descRes = await ecsClient.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
        const task = descRes.tasks?.[0];
        if (task && task.lastStatus === "RUNNING") {
            const eniAttachment = task.attachments?.find(a => a.type === "ElasticNetworkInterface");
            const eniDetail = eniAttachment?.details?.find(d => d.name === "networkInterfaceId");
            if (eniDetail && eniDetail.value) {
                eniId = eniDetail.value;
                break;
            }
        } else if (task && task.lastStatus === "STOPPED") {
            throw new Error(`Task stopped unexpectedly: ${task.stoppedReason}`);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    if (!eniId) throw new Error("Task did not reach RUNNING state in time or ENI not found");

    const eniRes = await ec2Client.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }));
    const publicIp = eniRes.NetworkInterfaces?.[0]?.Association?.PublicIp;
    if (!publicIp) throw new Error("No Public IP found for task ENI");

    await workerLog(deploymentId, `Task reached RUNNING state. Extracted Public IP: ${publicIp}`);
    return publicIp;
}

// Helper to update Cloudflare DNS
async function updateCloudflareDNS(slug: string, ip: string, deploymentId: string) {
    if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) {
        await workerLog(deploymentId, "WARNING: Cloudflare credentials not set, skipping DNS update.", "stderr");
        return;
    }
    await workerLog(deploymentId, `Updating Cloudflare DNS for ${slug}.lonch.cloud -> ${ip}...`);
    
    const headers = {
        "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
    };
    
    // Check if record exists
    const searchRes = await axios.get(`https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${slug}.lonch.cloud`, { headers });
    const records = searchRes.data.result;
    
    if (records && records.length > 0) {
        const recordId = records[0].id;
        await axios.put(`https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`, {
            type: "A",
            name: `${slug}.lonch.cloud`,
            content: ip,
            proxied: true
        }, { headers });
    } else {
        await axios.post(`https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
            type: "A",
            name: `${slug}.lonch.cloud`,
            content: ip,
            proxied: true
        }, { headers });
    }
    await workerLog(deploymentId, `Cloudflare DNS updated successfully. Traffic is now routing!`);
}

export async function authenticateECR(deploymentId: string) {
    await workerLog(deploymentId, `Authenticating with AWS ECR...`);
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
        
        child.stdout.on('data', (data: Buffer) => workerLog(deploymentId, `[Docker Login] ${data.toString().trim()}`));
        child.stderr.on('data', (data: Buffer) => workerLog(deploymentId, `[Docker Login Error] ${data.toString().trim()}`));
        
        child.on('close', (code: number) => {
            if (code === 0) resolve();
            else reject(new Error(`Docker login failed with exit code ${code}`));
        });

        child.stdin.write(password as string);
        child.stdin.end();
    });
}

export async function ensureEcrRepositoryExists(deploymentId: string) {
    if (!AWS_ECR_REPOSITORY_URI) return;
    const repoName = AWS_ECR_REPOSITORY_URI.split('/').slice(1).join('/');
    
    try {
        await ecrClient.send(new DescribeRepositoriesCommand({ repositoryNames: [repoName] }));
    } catch (err: any) {
        if (err.name === 'RepositoryNotFoundException') {
            await workerLog(deploymentId, `ECR Repository '${repoName}' not found. Creating it...`);
            await ecrClient.send(new CreateRepositoryCommand({ repositoryName: repoName }));
            await workerLog(deploymentId, `ECR Repository '${repoName}' created successfully.`);
        } else {
            throw err;
        }
    }
}

async function ensureCloudwatchLogGroupExists(slug: string, deploymentId: string) {
    const logGroupName = `/ecs/lonch-${slug}`;
    try {
        await cloudwatchClient.send(new CreateLogGroupCommand({ logGroupName }));
        await workerLog(deploymentId, `Created CloudWatch Log Group: ${logGroupName}`);
    } catch (err: any) {
        if (err.name === 'ResourceAlreadyExistsException') {
            // Already exists, ignore
        } else {
            await workerLog(deploymentId, `Warning: Failed to pre-create log group ${logGroupName}: ${err.message}`, "stderr");
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

export async function provisionNewEcsService(project: any, imageTag: string, appPort: number, deploymentId: string): Promise<string> {

    await workerLog(deploymentId, `No ECS Service found for project. Provisioning new ALB Target Group and ECS Service...`);

    const envs = checkEnvVar(project, appPort)

    await ensureCloudwatchLogGroupExists(project.slug, deploymentId);

    // --- SKIPPED TO SAVE COSTS: ALB TARGET GROUP & ROUTING ---
    /*
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
    */
    const targetGroupArn = "placeholder-skipped";

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
        loadBalancers: [] // SKIPPED ALB
        /*
        loadBalancers: [
            {
                targetGroupArn: targetGroupArn,
                containerName: `app-${project.slug}`,
                containerPort: appPort
            }
        ]
        */
    }));

    const newServiceArn = createServiceRes.service?.serviceArn;
    if (!newServiceArn) throw new Error("Failed to create ECS Service");

    // Update Project in DB
    await prisma.project.update({
        where: { id: project.id },
        data: { ecsServiceArn: newServiceArn }
    });

    await workerLog(deploymentId, `Successfully provisioned new ECS Service: ${newServiceArn}`);
    
    // Cloudflare Zero-Cost Routing Hack
    const publicIp = await getTaskPublicIp("lonch-production-cluster", `svc-lonch-${project.slug}`, deploymentId);
    await updateCloudflareDNS(project.slug, publicIp, deploymentId);

    return newServiceArn;
}

export async function updateExistingEcsService(project: any, imageTag: string, appPort: number, deploymentId: string): Promise<void> {
    await workerLog(deploymentId, `Updating existing ECS service...`);


    // code duplication

    const envVar = checkEnvVar(project, appPort);

    await ensureCloudwatchLogGroupExists(project.slug, deploymentId);

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
    
    // Cloudflare Zero-Cost Routing Hack
    const serviceName = project.ecsServiceArn.split('/').pop();
    const publicIp = await getTaskPublicIp("lonch-production-cluster", serviceName, deploymentId);
    await updateCloudflareDNS(project.slug, publicIp, deploymentId);
}

export async function waitForEcsService(project: any, deploymentId: string) {
    await workerLog(deploymentId, `Waiting for ECS service to reach steady state (this usually takes 2-4 minutes)...`);
    await waitUntilServicesStable(
        { client: ecsClient, maxWaitTime: 600 },
        { cluster: "lonch-production-cluster", services: [project.ecsServiceArn] }
    );
    await workerLog(deploymentId, `ECS service is now completely stable and running!`);
}
