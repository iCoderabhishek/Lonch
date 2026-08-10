import {
    ECSClient,
    UpdateServiceCommand,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
    CreateServiceCommand,
    AssignPublicIp
} from "@aws-sdk/client-ecs";
import {
    ECRClient,
    GetAuthorizationTokenCommand
} from "@aws-sdk/client-ecr";
import {
    ElasticLoadBalancingV2Client,
    CreateTargetGroupCommand,
    CreateRuleCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
    AWS_S3_REGION,
    AWS_ECR_REGION,
    AWS_VPC_ID,
    AWS_ALB_LISTENER_ARN,
    AWS_ECS_SUBNETS,
    AWS_ECS_SECURITY_GROUPS,
    AWS_ECS_EXECUTION_ROLE_ARN
} from "../libs/env-lib";
import { prisma } from "../libs/prisma";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);

const ecsClient = new ECSClient({ region: AWS_S3_REGION });
const albClient = new ElasticLoadBalancingV2Client({ region: AWS_S3_REGION });
const ecrClient = new ECRClient({ region: AWS_ECR_REGION });

export async function authenticateECR() {
    console.log(`[Worker] Authenticating with AWS ECR...`);
    const authResponse = await ecrClient.send(new GetAuthorizationTokenCommand({}));
    const authData = authResponse.authorizationData?.[0];
    if (!authData || !authData.authorizationToken) {
        throw new Error("Failed to get ECR authorization token");
    }

    const decodedAuth = Buffer.from(authData.authorizationToken, 'base64').toString('utf-8');
    const [username, password] = decodedAuth.split(':');

    await execFileAsync('sh', ['-c', `echo "${password}" | docker login --username ${username} --password-stdin ${authData.proxyEndpoint}`]);
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

    // 1. Create Target Group in ALB
    const tgResponse = await albClient.send(new CreateTargetGroupCommand({
        Name: `tg-lonch-${project.slug.substring(0, 16)}`,
        Protocol: "HTTP",
        Port: appPort,
        VpcId: AWS_VPC_ID,
        TargetType: "ip",
        HealthCheckPath: "/",
        HealthCheckIntervalSeconds: 30,
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
                    Values: [`${project.slug}.lonch.0bhishek.com`, `${project.slug}.localhost`]
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
                        "awslogs-region": AWS_S3_REGION,
                        "awslogs-stream-prefix": "ecs",
                        "awslogs-create-group": "true"
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
        family: taskDef.family,
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
