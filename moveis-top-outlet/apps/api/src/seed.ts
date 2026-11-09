import { prisma } from './db.js';
import { env } from './env.js';
import { hashPassword } from './security.js';

// Cria o Admin Master a partir das variáveis de ambiente (nunca por cadastro na tela) e os parâmetros iniciais.
if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env para criar o Admin Master.');

if (await prisma.user.findFirst({ where: { role: 'ADMIN' } })) {
  console.log('Admin Master já existe. Nada foi alterado.');
} else {
  await prisma.user.create({
    data: { name: env.ADMIN_NAME, email: env.ADMIN_EMAIL.toLowerCase(), passwordHash: await hashPassword(env.ADMIN_PASSWORD), role: 'ADMIN' },
  });
  console.log('Admin Master criado. No primeiro login, ative o 2FA.');
}

const padroes = { license_active: true, margin_alert_min_pct: 10, allow_negative_stock: false, offline_max_days: 7 };
for (const [key, value] of Object.entries(padroes)) {
  await prisma.systemSetting.upsert({ where: { key }, update: {}, create: { key, value } });
}
await prisma.$disconnect();
