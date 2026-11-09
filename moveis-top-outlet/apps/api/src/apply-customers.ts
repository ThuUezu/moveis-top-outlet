import type { DataImportRow, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import type { DadosCliente, DadosContato, DadosEndereco } from './import-customers.js';

export const optsClientes = z.object({
  modo: z.enum(['SOMENTE_CRIAR', 'CRIAR_E_ATUALIZAR', 'REVISAR']),
  decisoes: z.array(z.object({ linha: z.number().int(), decisao: z.enum(['CRIAR', 'ATUALIZAR', 'IGNORAR']) })).optional(),
  confirmarAvisos: z.boolean().default(false),
});
export type OptsClientes = z.infer<typeof optsClientes>;

type Row = DataImportRow;
type Res = { action: string; entity?: string; entityId?: string; previous?: Record<string, unknown>; message?: string };
const json = (v: unknown) => v as Prisma.InputJsonValue;
const isEnd = (r: Row): r is Row & { data: DadosEndereco } => (r.data as DadosEndereco | null)?.aba === 'enderecos';
const isCont = (r: Row): r is Row & { data: DadosContato } => (r.data as DadosContato | null)?.aba === 'contatos';

/** Vendas chegam na Etapa 6; enquanto não existirem, criado pode ser removido. */
async function clienteTemVendas(id: string): Promise<boolean> {
  try {
    const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM sales WHERE customer_id = $1`, id);
    return Number(r[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Confirma a importação de clientes em lotes (barra de progresso via GET /imports). */
export async function confirmarClientes(impId: string, opts: OptsClientes) {
  const rows = await prisma.dataImportRow.findMany({ where: { importId: impId }, orderBy: { line: 'asc' } });
  const clientes = rows.filter((r) => !isEnd(r) && !isCont(r));
  const ligacoes = rows.filter((r) => isEnd(r) || isCont(r));
  const out = new Map<string, Res>();
  const elegivel = (s: string) => s === 'OK' || (s === 'AVISO' && opts.confirmarAvisos);
  for (const r of rows) {
    if (r.status === 'ERRO') out.set(r.id, { action: 'ERRO' });
    else if (!elegivel(r.status)) out.set(r.id, { action: 'IGNORADO', message: 'Aviso não confirmado.' });
  }
  const pendentes = clientes.filter((r) => !out.has(r.id));
  const decisao = (linha: number) => opts.decisoes?.find((d) => d.linha === linha)?.decisao;
  const totais = { criados: 0, atualizados: 0, ignorados: 0, erros: 0, processados: 0, total: pendentes.length };

  const docParaId = new Map<string, string>(); // documento normalizado → id do cliente nesta importação
  const extrasCriados = new Map<string, { enderecos: string[]; contatos: string[] }>(); // rowId do cliente → vínculos criados

  const marcar = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += 100)
      await Promise.all(ids.slice(i, i + 100).map((id) => {
        const r = rows.find((x) => x.id === id)!;
        const x = out.get(id)!;
        return prisma.dataImportRow.update({ where: { id }, data: { action: x.action, entity: x.entity, entityId: x.entityId, previous: x.previous ? json(x.previous) : undefined, messages: x.message ? [...(r.messages as string[]), x.message] : undefined } });
      }));
  };

  const LOTE = 250;
  for (let i = 0; i < pendentes.length; i += LOTE) {
    const lote = pendentes.slice(i, i + LOTE);
    await prisma.$transaction(async (tx) => {
      const existentes = await tx.customer.findMany({ select: { id: true, document: true } });
      const porDoc = new Map(existentes.map((c) => [c.document, c.id]));
      for (const r of lote) {
        const d = r.data as unknown as DadosCliente;
        const existente = porDoc.get(d.documento);
        if (existente && opts.modo === 'SOMENTE_CRIAR') { out.set(r.id, { action: 'IGNORADO', message: 'Cliente já cadastrado (modo somente criar).' }); continue; }
        if (existente && opts.modo === 'REVISAR' && decisao(r.line) === 'IGNORAR') { out.set(r.id, { action: 'IGNORADO', message: 'Ignorado na revisão.' }); continue; }
        if (!existente && opts.modo === 'REVISAR' && decisao(r.line) === 'IGNORAR') { out.set(r.id, { action: 'IGNORADO', message: 'Ignorado na revisão.' }); continue; }
        const data = {
          personType: d.tipoPessoa, priceList: d.listaPreco, name: d.nome, nickname: d.apelido, rg: d.rg, rgIssuer: d.emissor,
          rgUf: d.ufEmissor, gender: d.sexo, birthDate: d.aniversario, phone: d.telefone, mobile: d.celular, email: d.email,
          website: d.site, notes: d.observacao, creditLimit: d.limiteCredito, nfeEmail: d.emailNfe,
          issWithheld: d.issRetido, consumerFinal: d.consumidorFinal, ruralProducer: d.produtorRural,
        };
        if (existente) { // células vazias NÃO apagam dados existentes
          const preenchido = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
          const antes = await tx.customer.findUniqueOrThrow({ where: { id: existente } });
          await tx.customer.update({ where: { id: existente }, data: preenchido });
          out.set(r.id, {
            action: 'ATUALIZADO', entity: 'customer', entityId: existente,
            previous: Object.fromEntries(Object.keys(preenchido).map((c) => [c, (antes as any)[c]])),
          });
          docParaId.set(d.documento, existente);
          totais.atualizados++;
        } else {
          const c = await tx.customer.create({
            data: { document: d.documento, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v ?? null])) } as Prisma.CustomerUncheckedCreateInput,
          });
          out.set(r.id, { action: 'CRIADO', entity: 'customer', entityId: c.id });
          porDoc.set(d.documento, c.id);
          docParaId.set(d.documento, c.id);
          totais.criados++;
        }
      }
    }, { timeout: 120_000, maxWait: 10_000 });
    totais.processados += lote.length;
    totais.erros = [...out.values()].filter((x) => x.action === 'ERRO').length;
    totais.ignorados = [...out.values()].filter((x) => x.action === 'IGNORADO').length;
    await prisma.dataImport.update({ where: { id: impId }, data: { status: 'APLICANDO', totals: json(totais) } });
    await marcar(lote.map((r) => r.id));
  }

  // Endereços e contatos: adicionados aos existentes, sem duplicar os idênticos.
  const ligPendentes = ligacoes.filter((r) => !out.has(r.id));
  const docsIgnorados = new Set(pendentes.filter((r) => out.get(r.id)?.action === 'IGNORADO').map((r) => (r.data as unknown as DadosCliente).documento));
  for (let i = 0; i < ligPendentes.length; i += 500) {
    const lote = ligPendentes.slice(i, i + 500);
    await prisma.$transaction(async (tx) => {
      for (const r of lote) {
        const d = r.data as unknown as DadosEndereco | DadosContato;
        if (docsIgnorados.has(d.documento)) { out.set(r.id, { action: 'IGNORADO', message: 'Cliente ignorado no modo escolhido.' }); continue; }
        const clienteId = docParaId.get(d.documento) ?? (await tx.customer.findUnique({ where: { document: d.documento }, select: { id: true } }))?.id;
        if (!clienteId) { out.set(r.id, { action: 'ERRO', message: 'Cliente não localizado na importação.' }); continue; }
        if (isEnd(r)) {
          const e = d as DadosEndereco;
          const jaTem = await tx.customerAddress.findFirst({ where: { customerId: clienteId, zipCode: e.exterior ? null : e.cep ?? null, street: e.endereco ?? '', number: e.numero ?? null, complement: e.complemento ?? null, district: e.bairro ?? null, city: e.cidade ?? null, state: e.uf ?? null } });
          if (jaTem) { out.set(r.id, { action: 'IGNORADO', message: 'Endereço idêntico já cadastrado.' }); continue; }
          if (e.principal) await tx.customerAddress.updateMany({ where: { customerId: clienteId }, data: { isMain: false } });
          const a = await tx.customerAddress.create({ data: { customerId: clienteId, zipCode: e.exterior ? null : e.cep ?? null, street: e.endereco ?? '', number: e.numero, complement: e.complemento, district: e.bairro, city: e.cidade, state: e.uf, isForeign: !!e.exterior, isMain: !!e.principal } });
          out.set(r.id, { action: 'CRIADO', entity: 'address', entityId: a.id });
          const dono = [...out.entries()].find(([, x]) => x.entityId === clienteId && (x.action === 'CRIADO' || x.action === 'ATUALIZADO'))?.[0];
          if (dono) { const ex = extrasCriados.get(dono) ?? { enderecos: [], contatos: [] }; ex.enderecos.push(a.id); extrasCriados.set(dono, ex); }
        } else {
          const c = d as DadosContato;
          const jaTem = await tx.customerContact.findFirst({ where: { customerId: clienteId, name: c.nome ?? '', phone: c.telefone ?? null, email: c.email ?? null } });
          if (jaTem) { out.set(r.id, { action: 'IGNORADO', message: 'Contato idêntico já cadastrado.' }); continue; }
          const ct = await tx.customerContact.create({ data: { customerId: clienteId, name: c.nome ?? '', phone: c.telefone, email: c.email, notes: c.observacao } });
          out.set(r.id, { action: 'CRIADO', entity: 'contact', entityId: ct.id });
          const dono = [...out.entries()].find(([, x]) => x.entityId === clienteId && (x.action === 'CRIADO' || x.action === 'ATUALIZADO'))?.[0];
          if (dono) { const ex = extrasCriados.get(dono) ?? { enderecos: [], contatos: [] }; ex.contatos.push(ct.id); extrasCriados.set(dono, ex); }
        }
      }
    }, { timeout: 120_000, maxWait: 10_000 });
    totais.processados += lote.length;
    await prisma.dataImport.update({ where: { id: impId }, data: { status: 'APLICANDO', totals: json(totais) } });
    await marcar(lote.map((r) => r.id));
  }

  // Vínculos criados ficam registrados no "previous" do cliente, para o desfazer removê-los.
  for (const [rowId, ex] of extrasCriados) {
    const x = out.get(rowId)!;
    x.previous = { ...(x.previous ?? {}), enderecosCriados: ex.enderecos, contatosCriados: ex.contatos };
    await prisma.dataImportRow.update({ where: { id: rowId }, data: { previous: json(x.previous) } });
  }

  const fim = { criados: totais.criados, atualizados: totais.atualizados, ignorados: [...out.values()].filter((x) => x.action === 'IGNORADO').length, erros: [...out.values()].filter((x) => x.action === 'ERRO').length };
  await prisma.dataImport.update({ where: { id: impId }, data: { status: 'APLICADA', mode: opts.modo, totals: json(fim), appliedAt: new Date() } });
  return fim;
}

/** Desfaz uma importação de clientes aplicada (somente a última). */
export async function desfazerClientes(impId: string) {
  const rows = await prisma.dataImportRow.findMany({
    where: { importId: impId, OR: [{ action: { in: ['CRIADO', 'ATUALIZADO'] }, entity: 'customer' }, { action: 'CRIADO', entity: { in: ['address', 'contact'] } }] },
    orderBy: { line: 'desc' },
  });
  const r = { removidos: 0, inativados: 0, restaurados: 0, vinculosRemovidos: 0 };
  for (const row of rows) {
    if (row.entity === 'address' || row.entity === 'contact') {
      await (row.entity === 'address' ? prisma.customerAddress.delete({ where: { id: row.entityId! } }) : prisma.customerContact.delete({ where: { id: row.entityId! } }))
        .then(() => r.vinculosRemovidos++).catch(() => {});
      continue;
    }
    const id = row.entityId!;
    if (row.action === 'ATUALIZADO') {
      const { enderecosCriados, contatosCriados, ...campos } = (row.previous ?? {}) as Record<string, any>;
      await prisma.customer.update({ where: { id }, data: campos });
      for (const aid of enderecosCriados ?? []) await prisma.customerAddress.delete({ where: { id: aid } }).then(() => r.vinculosRemovidos++).catch(() => {});
      for (const cid of contatosCriados ?? []) await prisma.customerContact.delete({ where: { id: cid } }).then(() => r.vinculosRemovidos++).catch(() => {});
      r.restaurados++;
    } else if (await clienteTemVendas(id)) {
      await prisma.customer.update({ where: { id }, data: { archived: true } });
      r.inativados++;
    } else {
      await prisma.customer.delete({ where: { id } });
      r.removidos++;
    }
  }
  return r;
}
