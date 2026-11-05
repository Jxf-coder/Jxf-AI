/**
 * 对象存储（MinIO / S3 兼容）。
 *
 * 只在真正用到时创建客户端：构建期（next build）不应因缺少 S3 环境变量而失败。
 * 上传走服务端 PutObject，下载走服务端 GetObject 转发——不暴露预签名地址，
 * 避免内网 MinIO 域名在浏览器侧不可达，也确保下载同样过 RLS。
 */

import { GetObjectCommand, PutObjectCommand, S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

import { loadEnv } from "@/lib/env";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) {
    return client;
  }
  const { s3 } = loadEnv();
  client = new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    // MinIO 默认按路径寻址
    forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
  });
  return client;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const { s3 } = loadEnv();
  await getClient().send(
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
    }),
  );
}

export async function getObject(key: string): Promise<{ body: Uint8Array; contentType: string }> {
  const { s3 } = loadEnv();
  const result = await getClient().send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error(`对象存储返回空内容：${key}`);
  }
  return { body: bytes, contentType: result.ContentType ?? "application/octet-stream" };
}

export async function deleteObject(key: string): Promise<void> {
  const { s3 } = loadEnv();
  await getClient().send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
}
