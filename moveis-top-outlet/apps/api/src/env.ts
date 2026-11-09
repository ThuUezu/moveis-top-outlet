import 'dotenv/config';
import { z } from 'zod';

export const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter 32 ou mais caracteres'),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    PORT: z.coerce.number().default(3333),
    ADMIN_NAME: z.string().default('Administrador'),
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(10).optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
  })
  .parse(process.env);
