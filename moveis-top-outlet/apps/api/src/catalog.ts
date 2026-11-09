import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, prisma } from './db.js';
import { buildTree, descendantIds, inherit, kitCostCents, wouldCycle } from './catalog-utils.js';
import { downloadUrl, removeObject, storageEnabled, uploadUrl } from './storage.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type P = { Params: { id: string } };
const money = z.number().min(0).max(999_999_999);
const uuid = z.string().uuid();
const mime = z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' } as const;
const NOT_FOUND = { erro: 'Registro não encontrado.' };
const SKU_DUP = { erro: 'Já existe um produto ou variação com este código (SKU).' };

const productBody = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(200),
  description: z.string().max(5000).nullish(),
  categoryId: uuid.nullish(),
  supplierId: uuid.nullish(),
  type: z.enum(['PRONTA_ENTREGA', 'ENCOMENDA']),
  costPrice: money,
  salePrice: money,
  stockQty: z.number().int().min(0).default(0),
  unit: z.string().max(10).default('un'),
  dimensions: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  lowStockThreshold: z.number().int().min(0).nullish(),
  catalogUrl: z.string().url().nullish(),
  isKit: z.boolean().default(false),
  active: z.boolean().default(true),
});
const variationBody = z.object({
  sku: z.string().trim().min(1).max(60),
  kind: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(80),
  costPrice: money.nullish(),
  salePrice: money.nullish(),
  stockQty: z.number().int().min(0).nullish(),
  active: z.boolean().default(true),
});
const supplierBody = z.object({
  name: z.string().trim().min(2).max(150),
  document: z.string().max(20).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().nullish(),
  notes: z.string().max(2000).nullish(),
  active: z.boolean().default(true),
});

// SKU único entre produtos e variações, sem diferenciar maiúsculas de minúsculas.
async function skuTaken(sku: string, ignore: { product?: string; variation?: string } = {}) {
  const sameSku = { equals: sku, mode: 'insensitive' as const };
  return (
    !!(await prisma.product.findFirst({ where: { sku: sameSku, id: { not: ignore.product } }, select: { id: true } })) ||
    !!(await prisma.productVariation.findFirst({ where: { sku: sameSku, id: { not: ignore.variation } }, select: { id: true } }))
  );
}

export async function catalogRoutes(app: FastifyInstance, g: { auth: Guard; admin: Guard }) {
  const log = (req: FastifyRequest, action: string, entity: string, entityId: string, before?: unknown, after?: unknown) =>
    audit({ userId: req.user.sub, action, entity, entityId, before, after, ip: req.ip });

  // ---------- Categorias ----------
  app.get('/categories', { preHandler: g.auth }, async () =>
    buildTree(await prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })));

  app.post('/categories', { preHandler: g.auth }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), parentId: uuid.nullish() }).parse(req.body);
    if (await prisma.category.findFirst({ where: { name: { equals: b.name, mode: 'insensitive' }, parentId: b.parentId ?? null } }))
      return reply.code(409).send({ erro: 'Já existe uma categoria com este nome neste nível.' });
    const c = await prisma.category.create({ data: { name: b.name, parentId: b.parentId ?? null } });
    await log(req, 'CATEGORIA_CRIADA', 'category', c.id, undefined, c);
    return reply.code(201).send(c);
  });

  app.patch<P>('/categories/:id', { preHandler: g.auth }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), parentId: uuid.nullable().optional(), active: z.boolean().optional() }).parse(req.body);
    const before = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send(NOT_FOUND);
    if (b.parentId !== undefined && wouldCycle(await prisma.category.findMany({ select: { id: true, name: true, parentId: true } }), before.id, b.parentId))
      return reply.code(400).send({ erro: 'Uma categoria não pode ficar dentro dela mesma ou de uma subcategoria sua.' });
    const after = await prisma.category.update({ where: { id: before.id }, data: b });
    await log(req, 'CATEGORIA_EDITADA', 'category', before.id, before, after);
    return after;
  });

  app.delete<P>('/categories/:id', { preHandler: g.admin }, async (req) => {
    const before = await prisma.category.delete({ where: { id: req.params.id } });
    await log(req, 'CATEGORIA_EXCLUIDA', 'category', before.id, before);
    return { ok: true };
  });

  // ---------- Fornecedores ----------
  app.get('/suppliers', { preHandler: g.auth }, async (req) => {
    const q = z.object({ q: z.string().optional(), all: z.enum(['1']).optional() }).parse(req.query);
    return prisma.supplier.findMany({
      where: { active: q.all ? undefined : true, name: q.q ? { contains: q.q, mode: 'insensitive' } : undefined },
      orderBy: { name: 'asc' },
    });
  });

  app.post('/suppliers', { preHandler: g.auth }, async (req, reply) => {
    const s = await prisma.supplier.create({ data: supplierBody.parse(req.body) });
    await log(req, 'FORNECEDOR_CRIADO', 'supplier', s.id, undefined, s);
    return reply.code(201).send(s);
  });

  app.patch<P>('/suppliers/:id', { preHandler: g.auth }, async (req, reply) => {
    const before = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send(NOT_FOUND);
    const after = await prisma.supplier.update({ where: { id: before.id }, data: supplierBody.partial().parse(req.body) });
    await log(req, 'FORNECEDOR_EDITADO', 'supplier', before.id, before, after);
    return after;
  });

  app.delete<P>('/suppliers/:id', { preHandler: g.admin }, async (req) => {
    const before = await prisma.supplier.delete({ where: { id: req.params.id } });
    await log(req, 'FORNECEDOR_EXCLUIDO', 'supplier', before.id, before);
    return { ok: true };
  });

  // ---------- Produtos ----------
  app.get('/products', { preHandler: g.auth }, async (req) => {
    const q = z.object({
      q: z.string().trim().optional(), categoryId: uuid.optional(), supplierId: uuid.optional(),
      type: z.enum(['PRONTA_ENTREGA', 'ENCOMENDA']).optional(), lowStock: z.enum(['1']).optional(),
      active: z.enum(['0', '1', 'all']).default('1'),
      sort: z.enum(['name', 'sku', 'salePrice', 'costPrice', 'createdAt']).default('name'), dir: z.enum(['asc', 'desc']).default('asc'),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);
    const where: Prisma.ProductWhereInput = { active: q.active === 'all' ? undefined : q.active === '1', type: q.type, supplierId: q.supplierId };
    if (q.categoryId) where.categoryId = { in: descendantIds(await prisma.category.findMany({ select: { id: true, name: true, parentId: true } }), q.categoryId) };
    if (q.q) {
      const c = { contains: q.q, mode: 'insensitive' as const };
      where.OR = [{ name: c }, { sku: c }, { category: { name: c } }, { supplier: { name: c } }, { variations: { some: { sku: c } } }];
    }
    if (q.lowStock) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE type = 'PRONTA_ENTREGA' AND low_stock_threshold IS NOT NULL AND stock_qty <= low_stock_threshold`;
      where.id = { in: rows.map((r) => r.id) };
    }
    const [total, items] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where, orderBy: { [q.sort]: q.dir }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { category: { select: { id: true, name: true } }, supplier: { select: { id: true, name: true } }, _count: { select: { variations: true } } },
      }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: items.map((p) => ({ ...p, lowStock: p.type === 'PRONTA_ENTREGA' && p.lowStockThreshold !== null && p.stockQty <= p.lowStockThreshold })),
    };
  });

  app.get<P>('/products/:id', { preHandler: g.auth }, async (req, reply) => {
    const p = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        category: true, supplier: true, variations: { orderBy: [{ kind: 'asc' }, { value: 'asc' }] }, media: { orderBy: { position: 'asc' } },
        kitItems: { include: { component: { select: { id: true, sku: true, name: true, costPrice: true } }, variation: { select: { id: true, sku: true, kind: true, value: true, costPrice: true } } } },
      },
    });
    if (!p) return reply.code(404).send(NOT_FOUND);
    const media = await Promise.all(p.media.map(async (m) => ({ ...m, url: storageEnabled ? await downloadUrl(m.key) : null })));
    const kitCostCalculado = p.kitItems.length
      ? kitCostCents(p.kitItems.map((i) => ({ unitCost: Number(inherit(i.variation?.costPrice, i.component.costPrice)), quantity: i.quantity }))) / 100
      : null;
    return { ...p, media, kitCostCalculado };
  });

  app.post('/products', { preHandler: g.auth }, async (req, reply) => {
    const b = productBody.parse(req.body);
    if (await skuTaken(b.sku)) return reply.code(409).send(SKU_DUP);
    const p = await prisma.product.create({ data: b });
    await log(req, 'PRODUTO_CRIADO', 'product', p.id, undefined, p);
    return reply.code(201).send(p);
  });

  app.patch<P>('/products/:id', { preHandler: g.auth }, async (req, reply) => {
    const b = productBody.partial().parse(req.body);
    const before = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send(NOT_FOUND);
    if (b.sku && (await skuTaken(b.sku, { product: before.id }))) return reply.code(409).send(SKU_DUP);
    const after = await prisma.$transaction(async (tx) => {
      if (b.isKit === false) await tx.kitItem.deleteMany({ where: { kitId: before.id } });
      return tx.product.update({ where: { id: before.id }, data: { ...b, ...(b.isKit === false ? { kitCostOverride: null } : {}) } });
    });
    await log(req, 'PRODUTO_EDITADO', 'product', before.id, before, after);
    return after;
  });

  app.delete<P>('/products/:id', { preHandler: g.admin }, async (req) => {
    const before = await prisma.product.delete({ where: { id: req.params.id } });
    await log(req, 'PRODUTO_EXCLUIDO', 'product', before.id, before);
    return { ok: true };
  });

  // ---------- Variações ----------
  app.post<P>('/products/:id/variations', { preHandler: g.auth }, async (req, reply) => {
    const b = variationBody.parse(req.body);
    if (!(await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true } }))) return reply.code(404).send(NOT_FOUND);
    if (await skuTaken(b.sku)) return reply.code(409).send(SKU_DUP);
    const v = await prisma.productVariation.create({ data: { ...b, productId: req.params.id } });
    await log(req, 'VARIACAO_CRIADA', 'variation', v.id, undefined, v);
    return reply.code(201).send(v);
  });

  app.patch<P>('/variations/:id', { preHandler: g.auth }, async (req, reply) => {
    const b = variationBody.partial().parse(req.body);
    const before = await prisma.productVariation.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send(NOT_FOUND);
    if (b.sku && (await skuTaken(b.sku, { variation: before.id }))) return reply.code(409).send(SKU_DUP);
    const after = await prisma.productVariation.update({ where: { id: before.id }, data: b });
    await log(req, 'VARIACAO_EDITADA', 'variation', before.id, before, after);
    return after;
  });

  app.delete<P>('/variations/:id', { preHandler: g.admin }, async (req) => {
    const before = await prisma.productVariation.delete({ where: { id: req.params.id } });
    await log(req, 'VARIACAO_EXCLUIDA', 'variation', before.id, before);
    return { ok: true };
  });

  // ---------- Kits ----------
  app.put<P>('/products/:id/kit', { preHandler: g.auth }, async (req, reply) => {
    const b = z.object({
      items: z.array(z.object({ productId: uuid, variationId: uuid.nullish(), quantity: z.number().int().min(1) })).min(1).max(50),
      costOverride: money.nullish(),
    }).parse(req.body);
    const kit = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!kit) return reply.code(404).send(NOT_FOUND);
    if (!kit.isKit) return reply.code(400).send({ erro: 'Este produto não está marcado como kit.' });
    const comps = new Map((await prisma.product.findMany({ where: { id: { in: b.items.map((i) => i.productId) } }, include: { variations: true } })).map((c) => [c.id, c]));
    for (const i of b.items) {
      const c = comps.get(i.productId);
      if (!c || c.isKit || c.id === kit.id) return reply.code(400).send({ erro: 'Componente inválido: um kit só pode conter produtos que não sejam kits.' });
      if (i.variationId && !c.variations.some((v) => v.id === i.variationId)) return reply.code(400).send({ erro: 'A variação escolhida não pertence ao produto.' });
    }
    const unitCost = (i: (typeof b.items)[number]) => {
      const c = comps.get(i.productId)!;
      return Number(inherit(c.variations.find((v) => v.id === i.variationId)?.costPrice, c.costPrice));
    };
    const calculado = kitCostCents(b.items.map((i) => ({ unitCost: unitCost(i), quantity: i.quantity }))) / 100;
    const custo = b.costOverride ?? calculado;
    await prisma.$transaction([
      prisma.kitItem.deleteMany({ where: { kitId: kit.id } }),
      prisma.kitItem.createMany({ data: b.items.map((i) => ({ kitId: kit.id, componentId: i.productId, variationId: i.variationId ?? null, quantity: i.quantity })) }),
      prisma.product.update({ where: { id: kit.id }, data: { costPrice: custo, kitCostOverride: b.costOverride ?? null } }),
    ]);
    await log(req, 'KIT_ATUALIZADO', 'product', kit.id, { costPrice: kit.costPrice }, { costPrice: custo, itens: b.items });
    return { costPrice: custo, kitCostCalculado: calculado };
  });

  // ---------- Fotos e catálogo (upload direto para o armazenamento, com URL assinada) ----------
  const noStorage = (reply: FastifyReply) => reply.code(503).send({ erro: 'Armazenamento de arquivos não configurado.' });

  app.post<P>('/products/:id/media/upload-url', { preHandler: g.auth }, async (req, reply) => {
    if (!storageEnabled) return noStorage(reply);
    const b = z.object({ contentType: mime, size: z.number().int().min(1).max(10 * 1024 * 1024) }).parse(req.body);
    if (!(await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true } }))) return reply.code(404).send(NOT_FOUND);
    const key = `products/${req.params.id}/${randomUUID()}${EXT[b.contentType]}`;
    return { key, url: await uploadUrl(key, b.contentType, b.size) };
  });

  app.post<P>('/products/:id/media', { preHandler: g.auth }, async (req, reply) => {
    const b = z.object({ key: z.string().max(200), contentType: mime }).parse(req.body);
    if (!b.key.startsWith(`products/${req.params.id}/`)) return reply.code(400).send({ erro: 'Arquivo inválido para este produto.' });
    const position = await prisma.productMedia.count({ where: { productId: req.params.id } });
    const m = await prisma.productMedia.create({
      data: { productId: req.params.id, key: b.key, contentType: b.contentType, kind: b.contentType === 'application/pdf' ? 'CATALOGO' : 'FOTO', position },
    });
    await log(req, 'MIDIA_ANEXADA', 'product', req.params.id, undefined, { id: m.id, kind: m.kind });
    return reply.code(201).send(m);
  });

  app.delete<P>('/media/:id', { preHandler: g.auth }, async (req, reply) => {
    const m = await prisma.productMedia.findUnique({ where: { id: req.params.id } });
    if (!m) return reply.code(404).send(NOT_FOUND);
    if (storageEnabled) await removeObject(m.key);
    await prisma.productMedia.delete({ where: { id: m.id } });
    await log(req, 'MIDIA_REMOVIDA', 'product', m.productId, { id: m.id, kind: m.kind });
    return { ok: true };
  });
}
