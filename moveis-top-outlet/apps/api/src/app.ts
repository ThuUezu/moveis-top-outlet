import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { audit, prisma } from './db.js';
import { catalogRoutes } from './catalog.js';
import { customerRoutes } from './customers.js';
import { importRoutes } from './imports.js';
import { env } from './env.js';
import { checkPassword, hashPassword, newToken, nextLockState, passwordSchema, sha256 } from './security.js';

type Scope = 'full' | 'setup2fa';
type Role = 'ADMIN' | 'USER';
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role; scope: Scope };
    user: { sub: string; role: Role; scope: Scope };
  }
}

const publicUser = { id: true, name: true, email: true, role: true, active: true, totpEnabled: true, createdAt: true } as const;
// O Admin Master precisa ativar o 2FA antes de acessar qualquer outra rota.
const scopeFor = (u: { role: Role; totpEnabled: boolean }): Scope => (u.role === 'ADMIN' && !u.totpEnabled ? 'setup2fa' : 'full');
const MASTER_PROTEGIDO = 'O Admin Master não pode ser alterado por esta tela.';

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true });
  await app.register(helmet);
  await app.register(cors, { origin: env.WEB_ORIGIN });
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(jwt, { secret: env.JWT_SECRET });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ erro: 'Dados inválidos.', detalhes: err.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })) });
    }
    if (err?.code === 'P2002') return reply.code(409).send({ erro: 'Já existe um registro com estes dados (código, nome ou e-mail repetido).' });
    if (err?.code === 'P2003') return reply.code(409).send({ erro: 'Este registro está vinculado a outros dados. Inative-o em vez de excluir.' });
    if (err?.code === 'P2025') return reply.code(404).send({ erro: 'Registro não encontrado.' });
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ erro: status >= 500 ? 'Erro interno do servidor.' : err.message });
  });

  // Permissões sempre checadas aqui no back-end.
  async function checkSession(req: FastifyRequest, reply: FastifyReply, allowSetup: boolean) {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ erro: 'Sessão inválida ou expirada.' });
    }
    const u = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { active: true } });
    if (!u?.active) return reply.code(401).send({ erro: 'Usuário inativo.' });
    if (!allowSetup && req.user.scope !== 'full') {
      return reply.code(403).send({ erro: 'Ative o 2FA para continuar.', codigo: '2FA_OBRIGATORIO' });
    }
  }
  const auth = (req: FastifyRequest, reply: FastifyReply) => checkSession(req, reply, false);
  const authSetup = (req: FastifyRequest, reply: FastifyReply) => checkSession(req, reply, true);
  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await checkSession(req, reply, false);
    if (r) return r;
    if (req.user.role !== 'ADMIN') return reply.code(403).send({ erro: 'Apenas o Admin Master pode fazer isso.' });
  };

  async function issue(u: { id: string; role: Role; totpEnabled: boolean }) {
    const scope = scopeFor(u);
    const access = app.jwt.sign({ sub: u.id, role: u.role, scope }, { expiresIn: '15m' });
    const refresh = newToken();
    await prisma.refreshToken.create({ data: { userId: u.id, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + 7 * 864e5) } });
    return { access, refresh, scope };
  }
  const revokeAll = (userId: string) => prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

  app.get('/health', async () => ({ ok: true }));

  // ---------- Autenticação ----------
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1), totp: z.string().length(6).optional() }).parse(req.body);
    const email = b.email.toLowerCase();
    const u = await prisma.user.findUnique({ where: { email } });
    const bad = async (msg: string) => {
      if (u) await prisma.user.update({ where: { id: u.id }, data: nextLockState(u.failedLogins) });
      await audit({ userId: u?.id, action: 'LOGIN_FALHA', entity: 'user', entityId: u?.id, after: { email }, ip: req.ip });
      return reply.code(401).send({ erro: msg });
    };
    if (!u || !u.active) return bad('E-mail ou senha incorretos.');
    if (u.lockedUntil && u.lockedUntil > new Date()) {
      return reply.code(423).send({ erro: 'Conta bloqueada por tentativas falhas. Tente novamente em alguns minutos.' });
    }
    if (!(await checkPassword(u.passwordHash, b.password))) return bad('E-mail ou senha incorretos.');
    if (u.totpEnabled) {
      if (!b.totp) return reply.code(401).send({ erro: 'Informe o código do aplicativo autenticador.', codigo: '2FA_REQUERIDO' });
      if (!authenticator.check(b.totp, u.totpSecret!)) return bad('Código 2FA inválido.');
    }
    await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
    await audit({ userId: u.id, action: 'LOGIN', entity: 'user', entityId: u.id, ip: req.ip });
    return { ...(await issue(u)), user: { id: u.id, name: u.name, email: u.email, role: u.role } };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const { refresh } = z.object({ refresh: z.string().min(10) }).parse(req.body);
    const t = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refresh) }, include: { user: true } });
    if (!t || t.revokedAt || t.expiresAt < new Date() || !t.user.active) return reply.code(401).send({ erro: 'Sessão expirada. Entre novamente.' });
    await prisma.refreshToken.update({ where: { id: t.id }, data: { revokedAt: new Date() } });
    return issue(t.user);
  });

  app.post('/auth/logout', async (req) => {
    const { refresh } = z.object({ refresh: z.string() }).parse(req.body);
    await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(refresh), revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: authSetup }, async (req) => ({
    ...(await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub }, select: publicUser })),
    scope: req.user.scope,
  }));

  app.post('/auth/2fa/setup', { preHandler: authSetup }, async (req, reply) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (u.totpEnabled) return reply.code(409).send({ erro: 'O 2FA já está ativo.' });
    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: u.id }, data: { totpSecret: secret } });
    return { secret, otpauth: authenticator.keyuri(u.email, 'Móveis Top Outlet', secret) };
  });

  app.post('/auth/2fa/enable', { preHandler: authSetup }, async (req, reply) => {
    const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!u.totpSecret || !authenticator.check(code, u.totpSecret)) return reply.code(400).send({ erro: 'Código inválido. Confira o aplicativo autenticador.' });
    await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: true } });
    await audit({ userId: u.id, action: '2FA_ATIVADO', entity: 'user', entityId: u.id, ip: req.ip });
    return issue({ ...u, totpEnabled: true });
  });

  // ---------- Usuários (somente Admin Master) ----------
  app.get('/users', { preHandler: admin }, () => prisma.user.findMany({ select: publicUser, orderBy: { createdAt: 'asc' } }));

  app.post('/users', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ name: z.string().min(2), email: z.string().email(), password: passwordSchema }).parse(req.body);
    const email = b.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) return reply.code(409).send({ erro: 'Já existe um usuário com este e-mail.' });
    const u = await prisma.user.create({ data: { name: b.name, email, passwordHash: await hashPassword(b.password), role: 'USER' }, select: publicUser });
    await audit({ userId: req.user.sub, action: 'USUARIO_CRIADO', entity: 'user', entityId: u.id, after: u, ip: req.ip });
    return reply.code(201).send(u);
  });

  app.patch<{ Params: { id: string } }>('/users/:id', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ name: z.string().min(2).optional(), active: z.boolean().optional() }).parse(req.body);
    const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: publicUser });
    if (!before) return reply.code(404).send({ erro: 'Usuário não encontrado.' });
    if (before.role === 'ADMIN') return reply.code(403).send({ erro: MASTER_PROTEGIDO });
    const after = await prisma.user.update({ where: { id: before.id }, data: b, select: publicUser });
    if (b.active === false) await revokeAll(before.id);
    await audit({ userId: req.user.sub, action: 'USUARIO_EDITADO', entity: 'user', entityId: before.id, before, after, ip: req.ip });
    return after;
  });

  app.post<{ Params: { id: string } }>('/users/:id/redefinir-senha', { preHandler: admin }, async (req, reply) => {
    const { password } = z.object({ password: passwordSchema }).parse(req.body);
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return reply.code(404).send({ erro: 'Usuário não encontrado.' });
    if (u.role === 'ADMIN') return reply.code(403).send({ erro: MASTER_PROTEGIDO });
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } });
    await revokeAll(u.id);
    await audit({ userId: req.user.sub, action: 'SENHA_REDEFINIDA', entity: 'user', entityId: u.id, ip: req.ip });
    return { ok: true };
  });

  // ---------- Log de auditoria (somente Admin Master) ----------
  app.get('/audit', { preHandler: admin }, async (req) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), action: z.string().optional(), userId: z.string().optional() }).parse(req.query);
    const where = { action: q.action, userId: q.userId };
    const [total, items] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * 50, take: 50 }),
    ]);
    return { total, page: q.page, items };
  });

  await app.register(catalogRoutes, { auth, admin });
  await app.register(customerRoutes, { auth, admin });
  await app.register(importRoutes, { auth, admin });

  return app;
}
