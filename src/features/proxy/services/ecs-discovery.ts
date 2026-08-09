import { ECSClient, ListTasksCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";
import { EC2Client, DescribeNetworkInterfacesCommand } from "@aws-sdk/client-ec2";
import { AWS_S3_REGION } from "../../../shared/libs/env-lib";
import { redis } from "../../../shared/libs/redis";

const ecs = new ECSClient({ region: AWS_S3_REGION });
const ec2 = new EC2Client({ region: AWS_S3_REGION });

/**
 * Retrieves the public IP of a running ECS Task for a given service.
 * It queries AWS ECS and EC2 APIs to find the ENI's public IP and caches it in Redis.
 */
export async function getLiveContainerIp(clusterArn: string, serviceName: string): Promise<string | null> {
    const cacheKey = `ecs:ip:${serviceName}`;
    const cachedIp = await redis.get(cacheKey);
    if (cachedIp) {
        return cachedIp;
    }

    try {
        // 1. List all running tasks for the service
        const listTasks = new ListTasksCommand({
            cluster: clusterArn,
            serviceName: serviceName,
            desiredStatus: "RUNNING"
        });
        
        const listRes = await ecs.send(listTasks);
        if (!listRes.taskArns || listRes.taskArns.length === 0) return null;

        // 2. Describe the first running task to get its network interface ID
        const describeTasks = new DescribeTasksCommand({
            cluster: clusterArn,
            tasks: [listRes.taskArns[0]!]
        });
        const descRes = await ecs.send(describeTasks);
        if (!descRes.tasks || descRes.tasks.length === 0) return null;

        const task = descRes.tasks[0];
        if (!task) return null;
        const eniAttachment = task.attachments?.find(a => a.type === "ElasticNetworkInterface");
        if (!eniAttachment) return null;

        const eniIdObj = eniAttachment.details?.find(d => d.name === "networkInterfaceId");
        if (!eniIdObj || !eniIdObj.value) return null;
        const eniId = eniIdObj.value;

        // 3. Describe the EC2 Network Interface to get the Public IP
        const descEni = new DescribeNetworkInterfacesCommand({
            NetworkInterfaceIds: [eniId]
        });
        const eniRes = await ec2.send(descEni);
        if (!eniRes.NetworkInterfaces || eniRes.NetworkInterfaces.length === 0) return null;

        const publicIp = eniRes.NetworkInterfaces[0]?.Association?.PublicIp;
        if (!publicIp) return null;

        // Cache the IP address in Redis for 5 minutes to avoid rate limits and reduce latency
        await redis.setex(cacheKey, 300, publicIp);
        
        return publicIp;
    } catch (error) {
        console.error(`[ECS Discovery] Error fetching IP for ${serviceName}:`, error);
        return null;
    }
}
