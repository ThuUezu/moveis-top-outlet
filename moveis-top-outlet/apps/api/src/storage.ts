import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';

// Cloudflare R2 (ou qualquer armazenamento compatível com S3). Os arquivos nunca passam pelo servidor nem ficam no disco dele.
const s3 =
  env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY
    ? new S3Client({ region: 'auto', endpoint: env.S3_ENDPOINT, credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } })
    : null;
const Bucket = env.S3_BUCKET!;

export const storageEnabled = !!s3;
/** Upload direto de um buffer (documentos de clientes, que não usam URL assinada). */
export const uploadBuffer = (Key: string, Body: Buffer, ContentType: string) => s3!.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
export const uploadUrl = (Key: string, ContentType: string, ContentLength: number) =>
  getSignedUrl(s3!, new PutObjectCommand({ Bucket, Key, ContentType, ContentLength }), { expiresIn: 300 });
export const downloadUrl = (Key: string) => getSignedUrl(s3!, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
export const removeObject = (Key: string) => s3!.send(new DeleteObjectCommand({ Bucket, Key }));
