export const REDIS_URL = process.env.REDIS_URL as string
export const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN as string
export const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID as string
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET as string
export const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL as string
export const GITHUB_APP_NAME = process.env.GITHUB_APP_NAME as string
export const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY as string
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID as string
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET as string

export const AWS_S3_REGION = process.env.AWS_S3_REGION as string
export const AWS_ECR_REGION = process.env.AWS_ECR_REGION || AWS_S3_REGION
export const AWS_S3_ACCESS_KEY_ID = process.env.AWS_S3_ACCESS_KEY_ID as string
export const AWS_S3_SECRET_ACCESS_KEY = process.env.AWS_S3_SECRET_ACCESS_KEY as string
export const AWS_S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME as string
export const AWS_S3_BASE_URL = process.env.AWS_S3_BASE_URL as string
export const DEPLOYMENT_DOMAIN = process.env.DEPLOYMENT_DOMAIN || "localhost:8000"
export const AWS_ECR_REPOSITORY_URI = process.env.AWS_ECR_REPOSITORY_URI as string

export const AWS_VPC_ID = process.env.AWS_VPC_ID as string
export const AWS_ALB_LISTENER_ARN = process.env.AWS_ALB_LISTENER_ARN as string
export const AWS_ECS_SUBNETS = process.env.AWS_ECS_SUBNETS as string
export const AWS_ECS_SECURITY_GROUPS = process.env.AWS_ECS_SECURITY_GROUPS as string
export const AWS_ECS_EXECUTION_ROLE_ARN = process.env.AWS_ECS_EXECUTION_ROLE_ARN as string
export const AWS_ALB_DNS_NAME = process.env.AWS_ALB_DNS_NAME as string