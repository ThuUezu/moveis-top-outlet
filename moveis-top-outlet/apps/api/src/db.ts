import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

const json = (v: unknown) => (v === undefined ? undefined : (v as Prisma.InputJsonValue));

/** Registra uma ação no log de auditoria. Nunca passe senhas ou CPF/CNPJ completos em before/after. */
export async function audit(a: {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}) {
  await prisma.auditLog.create({
    data: { userId: a.userId, action: a.action, entity: a.entity, entityId: a.entityId, ip: a.ip, before: json(a.before), after: json(a.after) },
  });
}
