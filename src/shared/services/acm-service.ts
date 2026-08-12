import { ACMClient, RequestCertificateCommand, DescribeCertificateCommand } from "@aws-sdk/client-acm";
import { ElasticLoadBalancingV2Client, AddListenerCertificatesCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { AWS_ECR_REGION, AWS_S3_ACCESS_KEY_ID, AWS_S3_SECRET_ACCESS_KEY, AWS_ALB_LISTENER_ARN } from "../libs/env-lib";

const acmClient = new ACMClient({
    region: AWS_ECR_REGION,
    credentials: {
        accessKeyId: AWS_S3_ACCESS_KEY_ID,
        secretAccessKey: AWS_S3_SECRET_ACCESS_KEY
    }
});

const elbv2Client = new ElasticLoadBalancingV2Client({
    region: AWS_ECR_REGION,
    credentials: {
        accessKeyId: AWS_S3_ACCESS_KEY_ID,
        secretAccessKey: AWS_S3_SECRET_ACCESS_KEY
    }
});

export const requestCertificate = async (domainName: string): Promise<string> => {
    const command = new RequestCertificateCommand({
        DomainName: domainName,
        ValidationMethod: "DNS"
    });
    
    const response = await acmClient.send(command);
    if (!response.CertificateArn) {
        throw new Error("Failed to request ACM certificate: ARN not returned");
    }
    return response.CertificateArn;
};

export const getCertificateStatus = async (certificateArn: string) => {
    const command = new DescribeCertificateCommand({
        CertificateArn: certificateArn
    });

    const response = await acmClient.send(command);
    const cert = response.Certificate;
    
    if (!cert) throw new Error("Certificate not found");

    let validationRecord = null;
    if (cert.DomainValidationOptions && cert.DomainValidationOptions.length > 0) {
        const option = cert.DomainValidationOptions[0];
        if (option && option.ResourceRecord) {
            validationRecord = {
                name: option.ResourceRecord.Name,
                value: option.ResourceRecord.Value
            };
        }
    }

    return {
        status: cert.Status, // 'PENDING_VALIDATION' | 'ISSUED' | 'FAILED' etc.
        validationRecord
    };
};

export const attachCertificateToAlb = async (certificateArn: string) => {
    if (!AWS_ALB_LISTENER_ARN) {
        throw new Error("AWS_ALB_LISTENER_ARN is not configured");
    }

    const command = new AddListenerCertificatesCommand({
        ListenerArn: AWS_ALB_LISTENER_ARN,
        Certificates: [{ CertificateArn: certificateArn }]
    });

    await elbv2Client.send(command);
};
