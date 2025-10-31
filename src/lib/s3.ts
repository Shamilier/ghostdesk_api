import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../config";

export type S3FactoryConfig = AppConfig["s3"];

export function createS3Client(config: S3FactoryConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export interface PresignedUploadRequest {
  bucket: string;
  key: string;
  expiresIn: number;
  contentType: string;
  metadata?: Record<string, string>;
}

export async function createPresignedUploadUrl(
  client: S3Client,
  request: PresignedUploadRequest
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: request.bucket,
    Key: request.key,
    ContentType: request.contentType,
    Metadata: request.metadata,
  });

  return getSignedUrl(client, command, { expiresIn: request.expiresIn });
}

export interface PresignedDownloadRequest {
  bucket: string;
  key: string;
  expiresIn: number;
  responseContentType?: string;
}

export async function createPresignedDownloadUrl(
  client: S3Client,
  request: PresignedDownloadRequest
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: request.bucket,
    Key: request.key,
    ResponseContentType: request.responseContentType,
  });

  return getSignedUrl(client, command, { expiresIn: request.expiresIn });
}

export interface HeadObjectResult {
  contentLength: number | undefined;
  etag: string | undefined;
  metadata: Record<string, string> | undefined;
  requestId: string | undefined;
}

export async function headObject(
  client: S3Client,
  bucket: string,
  key: string
): Promise<HeadObjectResult> {
  const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);
  return {
    contentLength: response.ContentLength ?? undefined,
    etag: response.ETag ?? undefined,
    metadata: response.Metadata,
    requestId: response.$metadata.requestId,
  };
}

export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
