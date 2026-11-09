import { describe, expect, it } from 'vitest';
import { nextLockState, passwordSchema, sha256 } from './security.js';

describe('bloqueio após tentativas falhas', () => {
  it('conta as falhas e bloqueia por 15 minutos na quinta', () => {
    expect(nextLockState(0)).toEqual({ failedLogins: 1, lockedUntil: null });
    const s = nextLockState(4, new Date('2026-01-01T10:00:00Z'));
    expect(s.failedLogins).toBe(0);
    expect(s.lockedUntil).toEqual(new Date('2026-01-01T10:15:00Z'));
  });
});

describe('senha e tokens', () => {
  it('exige senha com 10 ou mais caracteres', () => {
    expect(passwordSchema.safeParse('curta').success).toBe(false);
    expect(passwordSchema.safeParse('uma-senha-longa').success).toBe(true);
  });
  it('hash do token é estável e diferente do token', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe('abc');
  });
});
