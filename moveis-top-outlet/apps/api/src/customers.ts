import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatarDocumento, mascararDocumento, mascararEmail, mascararTelefone, normalizarDocumento, soDigitos, validarUf } from './cpfcnpj.js';
import { audit, prisma } from './db.js';
import { downloadUrl, removeObject, storageEnabled, uploadBuffer } from './storage.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type P = { Params: { id: string } };

/** Vendas ainda não existem (Etapa 6): consulta defensiva que passa a valer quando a tabela for criada. */
async function clienteTemVendas(id: string): Promise<boolean> {
  try {
    const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM sales WHERE customer_id = $1`, id);
    return Number(r[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}
/** Crédito utilizado (crediário próprio em aberto). Etapa 6 passa a calcular de verdade. */
async function creditoUtilizado(id: string): Promise<number> {
  try {
    const r = await prisma.$queryRawUnsafe<{ v: string | null }[]>(
      `SELECT SUM(COALESCE(sp.valor, 0))::text AS v FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.customer_id = $1 AND sp.status = 'ABERTO'`, id);
    return Number(r[0]?.v ?? 0);
  } catch {
    return 0;
  }
}

const dadosPrincipais = z.object({
  personType: z.enum(['FISICA', 'JURIDICA']),
  priceList: z.enum(['PADRAO', 'BLOQUEADO']).default('PADRAO'),
  name: z.string().min(2, 'Informe o nome.'),
  nickname: z.string().nullish(),
  document: z.string().min(1, 'Informe o CPF/CNPJ.'),
  rg: z.string().nullish(), rgIssuer: z.string().nullish(),
  rgUf: z.string().nullish().refine((v) => !v || validarUf(v), 'UF emissor inválida.'),
  gender: z.enum(['M', 'F']).nullish(),
  birthDate: z.coerce.date().nullish(),
  phone: z.string().nullish(), mobile: z.string().nullish(),
  email: z.string().email('E-mail inválido.').nullish(),
  website: z.string().nullish(), notes: z.string().nullish(),
  creditLimit: z.coerce.number().min(0, 'O limite não pode ser negativo.').nullish(),
  nfeEmail: z.string().email('E-mail do destinatário da NFe inválido.').nullish(),
  issWithheld: z.boolean().default(false),
  consumerFinal: z.boolean().default(false),
  ruralProducer: z.boolean().default(false),
});

const normalizado = (v: string) => {
  const d = normalizarDocumento(v);
  if (!d) throw new Error('CPF/CNPJ inválido (dígitos verificadores não conferem).');
  return d;
};

/** Visão da listagem: CPF/CNPJ e telefones mascarados (LGPD), sem dados bancários. */
const paraLista = (c: { id: string; name: string; nickname: string | null; document: string; phone: string | null; mobile: string | null; email: string | null; priceList: string; archived: boolean; createdAt: Date }) => ({
  id: c.id, nome: c.name, apelido: c.nickname, documento: mascararDocumento(c.document), tipoDocumento: c.document.length === 11 ? 'CPF' : 'CNPJ',
  telefone: c.phone ? mascararTelefone(c.phone) : null, celular: c.mobile ? mascararTelefone(c.mobile) : null,
  email: c.email ? mascararEmail(c.email) : null, listaPreco: c.priceList, arquivado: c.archived, criadoEm: c.createdAt,
});

const fone = (v?: string | null) => { const d = soDigitos(v ?? ''); return d.length >= 10 && d.length <= 11 ? d : undefined; };

export async function customerRoutes(app: FastifyInstance, g: { auth: Guard; admin: Guard }) {
  const log = (req: FastifyRequest, action: string, entityId: string, extra?: Record<string, unknown>) =>
    audit({ userId: req.user.sub, action, entity: 'customer', entityId, after: extra, ip: req.ip });

  // ---------- ViaCEP (preenchimento automático de endereço) ----------
  app.get('/cep/:cep', { preHandler: g.auth }, async (req, reply) => {
    const { cep } = z.object({ cep: z.string().regex(/^\d{8}$/, 'CEP inválido.') }).parse(req.params);
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(5000) });
    const d = (await r.json()) as any;
    if (d?.erro) return reply.code(404).send({ erro: 'CEP não encontrado.' });
    return { endereco: d.logradouro ?? '', bairro: d.bairro ?? '', cidade: d.localidade ?? '', uf: d.uf ?? '' };
  });

  // ---------- Listagem (com busca e máscara LGPD) ----------
  app.get('/customers', { preHandler: g.auth }, async (req) => {
    const q = z.object({
      busca: z.string().optional(), arquivados: z.coerce.boolean().default(false),
      page: z.coerce.number().int().min(1).default(1),
    }).parse(req.query);
    const d = soDigitos(q.busca ?? '');
    const where = {
      archived: q.arquivados,
      ...(q.busca
        ? d.length >= 3
          ? { OR: [{ name: { contains: q.busca, mode: 'insensitive' as const } }, { document: { contains: d } }, { phone: { contains: d } }, { mobile: { contains: d } }] }
          : { name: { contains: q.busca, mode: 'insensitive' as const } }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip: (q.page - 1) * 20, take: 20 }),
    ]);
    return { total, page: q.page, items: items.map(paraLista) };
  });

  // ---------- Criação ----------
  app.post('/customers', { preHandler: g.auth }, async (req, reply) => {
    const b = dadosPrincipais.parse(req.body);
    const document = normalizado(b.document);
    if (await prisma.customer.findUnique({ where: { document } })) return reply.code(409).send({ erro: 'Já existe um cliente com este CPF/CNPJ.' });
    const { document: _doc, ...rest } = b;
    const c = await prisma.customer.create({
      data: {
        ...rest, document,
        phone: fone(b.phone), mobile: fone(b.mobile),
        rgUf: b.rgUf?.toUpperCase(), email: b.email?.toLowerCase(), nfeEmail: b.nfeEmail?.toLowerCase(),
      },
      select: { id: true, name: true },
    });
    await log(req, 'CLIENTE_CRIADO', c.id, { nome: c.name, documento: mascararDocumento(document) });
    return reply.code(201).send(c);
  });

  // ---------- Ficha completa (acesso a dados sensíveis vai ao log) ----------
  app.get<P>('/customers/:id', { preHandler: g.auth }, async (req, reply) => {
    const c = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: { addresses: { orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }] }, contacts: true, bankData: true, documents: { select: { id: true, fileName: true, contentType: true, size: true, createdAt: true }, orderBy: { createdAt: 'desc' } } },
    });
    if (!c) return reply.code(404).send({ erro: 'Cliente não encontrado.' });
    await log(req, 'CLIENTE_DADO_SENSIVEL', c.id, { motivo: 'ficha completa', documento: mascararDocumento(c.document) });
    return {
      ...c, document: formatarDocumento(c.document), creditLimit: c.creditLimit ? Number(c.creditLimit) : null,
      addresses: c.addresses.map((a) => ({ ...a, zipCode: a.zipCode ? a.zipCode.replace(/(\d{5})(\d{3})/, '$1-$2') : null })),
    };
  });

  // ---------- Edição ----------
  app.patch<P>('/customers/:id', { preHandler: g.auth }, async (req, reply) => {
    const b = dadosPrincipais.partial().parse(req.body);
    const atual = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!atual) return reply.code(404).send({ erro: 'Cliente não encontrado.' });
    let document = atual.document;
    if (b.document && normalizarDocumento(b.document) !== atual.document) {
      document = normalizado(b.document);
      if (await prisma.customer.findUnique({ where: { document } })) return reply.code(409).send({ erro: 'Já existe um cliente com este CPF/CNPJ.' });
    }
    const { document: _doc, ...rest } = b;
    const data = {
      ...rest, ...(b.document ? { document } : {}),
      ...(b.phone !== undefined && { phone: fone(b.phone) }), ...(b.mobile !== undefined && { mobile: fone(b.mobile) }),
      ...(b.rgUf && { rgUf: b.rgUf.toUpperCase() }), ...(b.email && { email: b.email.toLowerCase() }), ...(b.nfeEmail && { nfeEmail: b.nfeEmail.toLowerCase() }),
    };
    const c = await prisma.customer.update({ where: { id: atual.id }, data });
    await log(req, 'CLIENTE_EDITADO', c.id, { antes: { nome: atual.name, documento: mascararDocumento(atual.document) }, depois: { nome: c.name, documento: mascararDocumento(c.document) } });
    return { ok: true };
  });

  // ---------- Exclusão / arquivamento ----------
  app.delete<P>('/customers/:id', { preHandler: g.auth }, async (req, reply) => {
    const q = z.object({ definitivo: z.coerce.boolean().default(false), confirmar: z.coerce.boolean().default(false) }).parse(req.query);
    const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!c) return reply.code(404).send({ erro: 'Cliente não encontrado.' });
    const ehAdmin = req.user.role === 'ADMIN';
    const emUso = await clienteTemVendas(c.id);

    if (!ehAdmin || !q.definitivo) {
      await prisma.customer.update({ where: { id: c.id }, data: { archived: true } });
      await log(req, 'CLIENTE_ARQUIVADO', c.id, { nome: c.name, documento: mascararDocumento(c.document) });
      return { acao: 'ARQUIVADO', mensagem: ehAdmin ? 'Cliente arquivado.' : 'Cliente arquivado. A exclusão definitiva é exclusiva do Admin Master.' };
    }
    if (emUso && !q.confirmar)
      return reply.code(409).send({ erro: 'Este cliente possui vendas vinculadas. Excluir definitivamente? Confirme para prosseguir (os dados de vendas serão mantidos).', requerConfirmacao: true });
    try {
      for (const doc of await prisma.customerDocument.findMany({ where: { customerId: c.id } }))
        if (storageEnabled) await removeObject(doc.key).catch(() => {});
      await prisma.customer.delete({ where: { id: c.id } });
      await log(req, 'CLIENTE_EXCLUIDO', c.id, { nome: c.name, documento: mascararDocumento(c.document), comVendas: emUso });
      return { acao: 'EXCLUIDO' };
    } catch (e: any) {
      if (e.code === 'P2003') {
        await prisma.customer.update({ where: { id: c.id }, data: { archived: true } });
        await log(req, 'CLIENTE_ARQUIVADO', c.id, { nome: c.name, motivo: 'possui vínculos' });
        return { acao: 'ARQUIVADO', mensagem: 'Possui vínculos com outros registros; foi arquivado em vez de excluído.' };
      }
      throw e;
    }
  });

  // ---------- Endereços ----------
  const enderecoSchema = z.object({
    zipCode: z.string().nullish(), street: z.string().min(1, 'Informe o endereço.'),
    number: z.string().nullish(), complement: z.string().nullish(), district: z.string().nullish(),
    city: z.string().nullish(), state: z.string().nullish().refine((v) => !v || validarUf(v), 'UF inválida.'),
    isForeign: z.boolean().default(false), isMain: z.boolean().default(false),
  });
  app.post<P>('/customers/:id/addresses', { preHandler: g.auth }, async (req, reply) => {
    const b = enderecoSchema.parse(req.body);
    if (!b.isForeign && !b.street) return reply.code(400).send({ erro: 'Informe o endereço.' });
    const cep = b.isForeign ? '' : soDigitos(b.zipCode ?? '');
    if (!b.isForeign && b.zipCode && cep.length !== 8) return reply.code(400).send({ erro: 'CEP inválido (8 dígitos).' });
    const end = await prisma.$transaction(async (tx) => {
      if (b.isMain) await tx.customerAddress.updateMany({ where: { customerId: req.params.id }, data: { isMain: false } });
      return tx.customerAddress.create({ data: { customerId: req.params.id, zipCode: cep || null, street: b.street, number: b.number, complement: b.complement, district: b.district, city: b.city, state: b.state?.toUpperCase(), isForeign: b.isForeign, isMain: b.isMain } });
    });
    await log(req, 'CLIENTE_ENDERECO', req.params.id, { enderecoId: end.id, principal: b.isMain });
    return reply.code(201).send(end);
  });
  app.delete<{ Params: { id: string; enderecoId: string } }>('/customers/:id/addresses/:enderecoId', { preHandler: g.auth }, async (req) => {
    await prisma.customerAddress.delete({ where: { id: req.params.enderecoId } });
    await log(req, 'CLIENTE_ENDERECO_REMOVIDO', req.params.id, { enderecoId: req.params.enderecoId });
    return { ok: true };
  });

  // ---------- Contatos ----------
  app.post<P>('/customers/:id/contacts', { preHandler: g.auth }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1, 'Informe o nome do contato.'), phone: z.string().nullish(), email: z.string().email('E-mail inválido.').nullish(), notes: z.string().nullish() }).parse(req.body);
    const ct = await prisma.customerContact.create({ data: { customerId: req.params.id, name: b.name, phone: fone(b.phone), email: b.email?.toLowerCase(), notes: b.notes } });
    return reply.code(201).send(ct);
  });
  app.delete<{ Params: { id: string; contatoId: string } }>('/customers/:id/contacts/:contatoId', { preHandler: g.auth }, async (req) => {
    await prisma.customerContact.delete({ where: { id: req.params.contatoId } });
    return { ok: true };
  });

  // ---------- Dados bancários (sensíveis: acesso vai ao log) ----------
  app.post<P>('/customers/:id/bank', { preHandler: g.auth }, async (req, reply) => {
    const b = z.object({ bankName: z.string().min(2, 'Informe o banco.'), agency: z.string().nullish(), account: z.string().nullish(), accountType: z.string().nullish(), pixKey: z.string().nullish(), notes: z.string().nullish() }).parse(req.body);
    const bk = await prisma.customerBankData.create({ data: { customerId: req.params.id, ...b } });
    await log(req, 'CLIENTE_DADO_SENSIVEL', req.params.id, { motivo: 'dados bancários incluídos' });
    return reply.code(201).send({ ...bk, account: bk.account ? '***' : null, pixKey: bk.pixKey ? '***' : null });
  });
  app.delete<{ Params: { id: string; bancoId: string } }>('/customers/:id/bank/:bancoId', { preHandler: g.auth }, async (req) => {
    await prisma.customerBankData.delete({ where: { id: req.params.bancoId } });
    return { ok: true };
  });

  // ---------- Documentos (arquivos no armazenamento de objetos) ----------
  try {
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  } catch {
    /* plugin já registrado pelas rotas de importação */
  }
  app.post<P>('/customers/:id/documents', { preHandler: g.auth }, async (req, reply) => {
    if (!storageEnabled) return reply.code(503).send({ erro: 'Armazenamento de arquivos não configurado (variáveis S3_* no servidor).' });
    const arq = await req.file();
    if (!arq) return reply.code(400).send({ erro: 'Envie um arquivo.' });
    const buf = await arq.toBuffer();
    const key = `clientes/${req.params.id}/${crypto.randomUUID()}-${arq.filename.replace(/[^\w.\-]/g, '_')}`;
    await uploadBuffer(key, buf, arq.mimetype);
    const doc = await prisma.customerDocument.create({ data: { customerId: req.params.id, key, fileName: arq.filename, contentType: arq.mimetype, size: buf.length } });
    await log(req, 'CLIENTE_DOCUMENTO', req.params.id, { arquivo: arq.filename, bytes: buf.length });
    return reply.code(201).send({ id: doc.id, fileName: doc.fileName, size: doc.size });
  });
  app.get<{ Params: { id: string; docId: string } }>('/customers/:id/documents/:docId/download', { preHandler: g.auth }, async (req, reply) => {
    const doc = await prisma.customerDocument.findUnique({ where: { id: req.params.docId } });
    if (!doc || doc.customerId !== req.params.id) return reply.code(404).send({ erro: 'Documento não encontrado.' });
    return { url: await downloadUrl(doc.key), nome: doc.fileName, contentType: doc.contentType };
  });
  app.delete<{ Params: { id: string; docId: string } }>('/customers/:id/documents/:docId', { preHandler: g.auth }, async (req) => {
    const doc = await prisma.customerDocument.findUnique({ where: { id: req.params.docId } });
    if (!doc) return { ok: true };
    await prisma.customerDocument.delete({ where: { id: doc.id } });
    if (storageEnabled) await removeObject(doc.key).catch(() => {});
    return { ok: true };
  });

  // ---------- Crédito ----------
  app.get<P>('/customers/:id/credit', { preHandler: g.auth }, async (req) => {
    const c = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, creditLimit: true } });
    if (!c) return { limite: 0, utilizado: 0, disponivel: 0 };
    const limite = c.creditLimit ? Number(c.creditLimit) : 0;
    const utilizado = await creditoUtilizado(c.id);
    return { limite, utilizado, disponivel: Math.max(0, limite - utilizado) };
  });

  // ---------- Histórico de compras e filtros de campanha ----------
  // As tabelas de vendas chegam na Etapa 6; até lá, devolvem vazio sem quebrar.
  app.get<P>('/customers/:id/history', { preHandler: g.auth }, async (req) => {
    try {
      const vendas = await prisma.$queryRawUnsafe(
        `SELECT s.id, s.data, s.total, si.quantidade, p.name AS produto, p.sku FROM sales s
         JOIN sale_items si ON si.sale_id = s.id JOIN products p ON p.id = si.product_id
         WHERE s.customer_id = $1 ORDER BY s.data DESC LIMIT 200`, req.params.id);
      return { vendas };
    } catch {
      return { vendas: [] };
    }
  });
  app.get('/customers/filters/purchased', { preHandler: g.auth }, async (req) => {
    const q = z.object({ produtoId: z.string().min(1), minQuantidade: z.coerce.number().int().min(1).default(1) }).parse(req.query);
    try {
      const items = await prisma.$queryRawUnsafe<{ customer_id: string; total: number }[]>(
        `SELECT s.customer_id, SUM(si.quantidade)::int AS total FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = $1 GROUP BY s.customer_id HAVING SUM(si.quantidade) >= $2`, q.produtoId, q.minQuantidade);
      const clientes = await prisma.customer.findMany({ where: { id: { in: items.map((i) => i.customer_id) } }, orderBy: { name: 'asc' } });
      return { items: clientes.map((c) => ({ ...paraLista(c), quantidade: items.find((i) => i.customer_id === c.id)?.total ?? 0 })) };
    } catch {
      return { items: [] }; // Etapa 6: ativa quando as tabelas de venda existirem
    }
  });

  // ---------- LGPD: exportar todos os dados do cliente ----------
  app.get<P>('/customers/:id/export', { preHandler: g.auth }, async (req, reply) => {
    const c = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: { addresses: true, contacts: true, bankData: true, documents: { select: { fileName: true, contentType: true, createdAt: true } } },
    });
    if (!c) return reply.code(404).send({ erro: 'Cliente não encontrado.' });
    await log(req, 'CLIENTE_EXPORTADO_LGPD', c.id, { documento: mascararDocumento(c.document) });
    return reply
      .header('Content-Disposition', `attachment; filename="cliente_${c.document}.json"`)
      .send({ exportadoEm: new Date().toISOString(), cliente: c });
  });
}
