// Example: src/shared/libs/s3.ts
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { PassThrough } from "stream";
import { AWS_S3_REGION, AWS_S3_ACCESS_KEY_ID, AWS_S3_SECRET_ACCESS_KEY, AWS_S3_BUCKET_NAME } from "../env-lib";
const s3 = new S3Client({
    region: AWS_S3_REGION,
    credentials: {
        accessKeyId: AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: AWS_S3_SECRET_ACCESS_KEY!,
    },
});

export async function uploadArtifactToS3(deploymentId: string, tarStream: NodeJS.ReadableStream) {
    const passThrough = new PassThrough();
    tarStream.pipe(passThrough);

    const upload = new Upload({
        client: s3,
        params: {
            Bucket: AWS_S3_BUCKET_NAME!,
            Key: `deployments/${deploymentId}/artifact.tar.gz`,
            Body: passThrough,
            ContentType: "application/gzip",
        },
    });

    // This handles chunking and multipart upload automatically
    await upload.done();
    console.log(`Successfully uploaded artifact for ${deploymentId}`);
}
