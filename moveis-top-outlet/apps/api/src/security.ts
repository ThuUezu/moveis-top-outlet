import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const MAX_TENTATIVAS = 5;
export const BLOQUEIO_MINUTOS = 15;

export const passwordSchema = z.string().min(10, 'A senha deve ter ao menos 10 caracteres').max(128);

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(48).toString('base64url');
export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });
export const checkPassword = (hash: string, p: string) => argon2.verify(hash, p);

/** Próximo estado de bloqueio após uma tentativa de login falha. */
export function nextLockState(failedLogins: number, now = new Date()) {
  const n = failedLogins + 1;
  if (n >= MAX_TENTATIVAS) {
    return { failedLogins: 0, lockedUntil: new Date(now.getTime() + BLOQUEIO_MINUTOS * 60_000) };
  }
  return { failedLogins: n, lockedUntil: null };
}
