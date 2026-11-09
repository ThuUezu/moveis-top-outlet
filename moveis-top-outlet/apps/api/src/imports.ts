import multipart from '@fastify/multipart';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { confirmarClientes, desfazerClientes, optsClientes } from './apply-customers.js';
import { inherit, kitCostCents } from './catalog-utils.js';
import { formatarDocumento } from './cpfcnpj.js';
import { audit, prisma } from './db.js';
import { ErroPlanilha, gerarCsv, gerarXlsx, lerAbas, lerPlanilha, type Celula } from './files.js';
import { COLUNAS_CONTATOS, COLUNAS_CLIENTES, COLUNAS_ENDERECOS, mapHeaderCliente, validarClientes } from './import-customers.js';
import { COLUNAS, norm, validar, type Dados, type Linha } from './import-products.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type P = { Params: { id: string } };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LABELS = COLUNAS.map(([, l]) => l as string);
const like = (s: string) => ({ equals: s, mode: 'insensitive' as const });
const json = (v: unknown) => v as Prisma.InputJsonValue;

async function enviar(reply: FastifyReply, formato: 'xlsx' | 'csv', nome: string, linhas: Celula[][], aba: string) {
  if (formato === 'csv') return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${nome}.csv"`).send(gerarCsv(linhas));
  return reply.header('Content-Type', XLSX).header('Content-Disposition', `attachment; filename="${nome}.xlsx"`).send(await gerarXlsx([[aba, linhas]]));
}
const formatoQ = z.object({ formato: z.enum(['xlsx', 'csv']).default('xlsx') });

export async function importRoutes(app: FastifyInstance, g: { auth: Guard; admin: Guard }) {
  try {
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  } catch {
    /* plugin já registrado (rotas de clientes) */
  }
  const log = (req: FastifyRequest, action: string, entityId: string, after?: unknown) =>
    audit({ userId: req.user.sub, action, entity: 'import', entityId, after, ip: req.ip });

  app.get('/imports/products/template', { preHandler: g.auth }, async (_req, reply) => {
    const instrucoes = [
      ['Como preencher'],
      ['Uma linha por produto. Para uma variação, preencha "SKU do produto-pai", "Variação tipo" (ex.: Cor) e "Variação valor" (ex.: Azul); o SKU da linha é o da variação.'],
      ['Tipo: "Pronta entrega" ou "Encomenda". Kit: "Sim" ou "Não". Componentes do kit: SKU:quantidade separados por ponto e vírgula (ex.: COZ-01:1; ARM-02:2).'],
      ['Células vazias não apagam dados já cadastrados. Apague as linhas de exemplo antes de importar.'],
    ];
    const exemplo = ['SOF-001', 'Sofá retrátil 3 lugares', 'Sala', 'Estofados', 'Fabricante X', 'Pronta entrega', 900, 1500, 3, 'un', '2,10 x 0,95 m', '', '', '', 'Não', '', ''];
    return reply.header('Content-Type', XLSX).header('Content-Disposition', 'attachment; filename="modelo_produtos.xlsx"')
      .send(await gerarXlsx([['Produtos', [LABELS, exemplo]], ['Instruções', instrucoes]]));
  });

  // ---------- Importação de CLIENTES (seção 10-B) ----------
  app.get('/imports/customers/template', { preHandler: g.auth }, async (_req, reply) => {
    const abaClientes = [
      COLUNAS_CLIENTES.map(([, l]) => l),
      ['Física', 'Padrão', 'Maria Silva', 'Maria', '529.982.247-25', '123456789', 'SSP', 'SP', 'Feminino', '15/03/1990', '(11) 3456-7890', '(11) 98765-4321', 'maria@email.com', '', 'Cliente indicada pelo João', '1500,00', 'nfe@email.com', 'Não', 'Sim', 'Não'],
    ];
    const abaEnderecos = [
      COLUNAS_ENDERECOS.map(([, l]) => l),
      ['529.982.247-25', '01310-100', 'Av. Paulista', '1000', 'Sala 10', 'Bela Vista', 'São Paulo', 'SP', 'Não', 'Sim'],
      ['529.982.247-25', '', '123 Main Street', '', '', '', 'Miami', '', 'Sim', 'Não'],
    ];
    const abaContatos = [COLUNAS_CONTATOS.map(([, l]) => l), ['529.982.247-25', 'João Silva', '(11) 98765-0000', 'joao@email.com', 'Sócio']];
    const instrucoes = [
      ['Como preencher'],
      ['Três abas ligadas pelo CPF/CNPJ: "Clientes" (uma linha por cliente), "Enderecos" e "Contatos" (opcional, várias linhas por cliente).'],
      ['Nome e CPF/CNPJ são obrigatórios. O CPF/CNPJ é validado; aceita com ou sem pontuação. Clientes já cadastrados são atualizados conforme o modo escolhido na confirmação (células vazias não apagam dados).'],
      ['Datas em dd/mm/aaaa. Valores em R$ com vírgula ou ponto. Campos Sim/Não aceitam "sim", "s", "x", "não", "n". Endereço no exterior aceita texto livre, sem CEP.'],
      ['Apague as linhas de exemplo antes de importar.'],
    ];
    return reply.header('Content-Type', XLSX).header('Content-Disposition', 'attachment; filename="modelo_clientes.xlsx"')
      .send(await gerarXlsx([['Clientes', abaClientes], ['Enderecos', abaEnderecos], ['Contatos', abaContatos], ['Instruções', instrucoes]]));
  });

  // 1) Envio + pré-visualização das três abas: nada é gravado ainda.
  app.post('/imports/customers/preview', { preHandler: g.auth }, async (req, reply) => {
    const arq = await req.file();
    if (!arq) return reply.code(400).send({ erro: 'Envie um arquivo .xlsx (use o botão "Baixar modelo de clientes").' });
    let abas;
    try {
      abas = await lerAbas(await arq.toBuffer(), arq.filename, mapHeaderCliente);
    } catch (e) {
      if (e instanceof ErroPlanilha) return reply.code(400).send({ erro: e.message });
      return reply.code(413).send({ erro: 'Arquivo muito grande (máximo 5 MB).' });
    }
    const clientes = abas.get('clientes') ?? [];
    if (!clientes.length) return reply.code(400).send({ erro: 'A aba "Clientes" não tem linhas de dados.' });
    if (clientes.length > 5000) return reply.code(400).send({ erro: 'Limite de 5.000 clientes por arquivo.' });
    const docsDb = new Set((await prisma.customer.findMany({ select: { document: true } })).map((c) => c.document));
    const r = validarClientes({ clientes, enderecos: abas.get('enderecos') ?? [], contatos: abas.get('contatos') ?? [] }, docsDb);

    // Para o modo "Revisar um a um": mostra o que mudaria nos clientes já existentes.
    const docsExistentes = r.clientes.filter((c) => c.existente && c.dados).map((c) => c.dados!.documento);
    const noBanco = new Map((await prisma.customer.findMany({ where: { document: { in: docsExistentes } } })).map((c) => [c.document, c]));
    const dataBr = (d: Date | null) => (d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '');
    const mudancas = r.clientes.flatMap((c) => {
      if (!c.existente || !c.dados) return [];
      const banco = noBanco.get(c.dados.documento);
      if (!banco) return [];
      const d = c.dados;
      const cmp: [string, unknown, unknown][] = [
        ['tipo_pessoa', banco.personType, d.tipoPessoa], ['lista_preco', banco.priceList, d.listaPreco], ['nome', banco.name, d.nome],
        ['apelido', banco.nickname, d.apelido], ['rg', banco.rg, d.rg], ['emissor', banco.rgIssuer, d.emissor], ['uf_emissor', banco.rgUf, d.ufEmissor],
        ['sexo', banco.gender, d.sexo], ['aniversario', dataBr(banco.birthDate), d.aniversario ? dataBr(d.aniversario) : undefined],
        ['telefone', banco.phone, d.telefone], ['celular', banco.mobile, d.celular], ['email', banco.email, d.email], ['site', banco.website, d.site],
        ['observacao', banco.notes, d.observacao], ['limite_credito', banco.creditLimit !== null ? Number(banco.creditLimit) : undefined, d.limiteCredito],
        ['email_nfe', banco.nfeEmail, d.emailNfe], ['iss_retido', banco.issWithheld, d.issRetido],
        ['consumidor_final', banco.consumerFinal, d.consumidorFinal], ['produtor_rural', banco.ruralProducer, d.produtorRural],
      ];
      return cmp.filter(([, atual, novo]) => novo !== undefined && novo !== null && String(atual ?? '') !== String(novo ?? ''))
        .map(([campo, atual, novo]) => ({ linha: c.linha, campo, atual: atual ?? '(vazio)', novo }));
    });

    const imp = await prisma.dataImport.create({ data: { kind: 'CLIENTES', fileName: arq.filename, userId: req.user.sub } });
    const rawDe = (aba: string) => (v: unknown) => json({ aba, v });
    await prisma.dataImportRow.createMany({
      data: [
        ...r.clientes.map((x) => ({ importId: imp.id, line: x.linha, status: x.status, messages: x.mensagens, data: x.dados ? json(x.dados) : undefined, raw: rawDe('clientes')(clientes.find((e) => e.linha === x.linha)?.v ?? {}) })),
        ...r.enderecos.map((x) => ({ importId: imp.id, line: x.linha, status: x.status, messages: x.mensagens, data: x.dados ? json(x.dados) : undefined, raw: rawDe('enderecos')(x.dados ? (abas.get('enderecos') ?? []).find((e) => e.linha === x.linha)?.v ?? {} : {}) })),
        ...r.contatos.map((x) => ({ importId: imp.id, line: x.linha, status: x.status, messages: x.mensagens, data: x.dados ? json(x.dados) : undefined, raw: rawDe('contatos')(x.dados ? (abas.get('contatos') ?? []).find((e) => e.linha === x.linha)?.v ?? {} : {}) })),
      ],
    });
    const tot = (ls: { status: string }[]) => ({ linhas: ls.length, ok: ls.filter((x) => x.status === 'OK').length, avisos: ls.filter((x) => x.status === 'AVISO').length, erros: ls.filter((x) => x.status === 'ERRO').length });
    const problema = (ls: { linha: number; status: string; mensagens: string[] }[]) => ls.filter((x) => x.status !== 'OK').slice(0, 60).map(({ linha, status, mensagens }) => ({ linha, status, mensagens }));
    return {
      importId: imp.id, totais: { clientes: tot(r.clientes), enderecos: tot(r.enderecos), contatos: tot(r.contatos) },
      linhasComProblema: { clientes: problema(r.clientes), enderecos: problema(r.enderecos), contatos: problema(r.contatos) },
      mudancas: mudancas.slice(0, 200),
    };
  });

  // 1) Envio + pré-visualização: nada é gravado nos produtos ainda.
  app.post('/imports/products/preview', { preHandler: g.auth }, async (req, reply) => {
    const arq = await req.file();
    if (!arq) return reply.code(400).send({ erro: 'Envie um arquivo .xlsx ou .csv.' });
    let entradas;
    try {
      entradas = await lerPlanilha(await arq.toBuffer(), arq.filename);
    } catch (e) {
      if (e instanceof ErroPlanilha) return reply.code(400).send({ erro: e.message });
      return reply.code(413).send({ erro: 'Arquivo muito grande (máximo 5 MB).' });
    }
    if (!entradas.length) return reply.code(400).send({ erro: 'A planilha não tem linhas de dados.' });
    if (entradas.length > 5000) return reply.code(400).send({ erro: 'Limite de 5.000 linhas por arquivo.' });

    const [prods, vars, cats, sups] = await Promise.all([
      prisma.product.findMany({ select: { sku: true, isKit: true } }), prisma.productVariation.findMany({ select: { sku: true } }),
      prisma.category.findMany({ select: { id: true, name: true, parentId: true } }), prisma.supplier.findMany({ select: { name: true } }),
    ]);
    const resultados = validar(entradas, {
      dbSkus: new Map<string, 'produto' | 'variacao'>([...prods.map((p) => [p.sku.toLowerCase(), 'produto'] as const), ...vars.map((v) => [v.sku.toLowerCase(), 'variacao'] as const)]),
      dbKits: new Set(prods.filter((p) => p.isKit).map((p) => p.sku.toLowerCase())),
      categorias: new Set(cats.filter((c) => !c.parentId).map((c) => norm(c.name))),
      subcategorias: new Set(cats.filter((c) => c.parentId).map((c) => `${norm(cats.find((p) => p.id === c.parentId)?.name ?? '')}/${norm(c.name)}`)),
      fabricantes: new Set(sups.map((s) => norm(s.name))),
    });
    const imp = await prisma.dataImport.create({ data: { kind: 'PRODUTOS', fileName: arq.filename, userId: req.user.sub } });
    await prisma.dataImportRow.createMany({
      data: resultados.map((r, i) => ({ importId: imp.id, line: r.linha, status: r.status, messages: r.mensagens, data: r.dados ? json(r.dados) : undefined, raw: json(entradas[i].v) })),
    });
    const n = (s: string) => resultados.filter((r) => r.status === s).length;
    return {
      importId: imp.id, totais: { linhas: resultados.length, ok: n('OK'), avisos: n('AVISO'), erros: n('ERRO') },
      linhasComProblema: resultados.filter((r) => r.status !== 'OK').slice(0, 100).map(({ linha, status, mensagens }) => ({ linha, status, mensagens })),
    };
  });

  app.get<P>('/imports/:id/rows', { preHandler: g.auth }, async (req) => {
    const q = z.object({ status: z.enum(['OK', 'AVISO', 'ERRO']).optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
    const where = { importId: req.params.id, status: q.status };
    const [total, items] = await Promise.all([
      prisma.dataImportRow.count({ where }),
      prisma.dataImportRow.findMany({ where, orderBy: { line: 'asc' }, skip: (q.page - 1) * 100, take: 100, select: { line: true, status: true, messages: true, action: true } }),
    ]);
    return { total, page: q.page, items };
  });

  // 2) Confirmação: grava tudo numa única transação (ou nada, se algo falhar).
  app.post<P>('/imports/:id/confirm', { preHandler: g.auth }, async (req, reply) => {
    const imp = await prisma.dataImport.findUnique({ where: { id: req.params.id } });
    if (!imp) return reply.code(404).send({ erro: 'Importação não encontrada.' });
    if (imp.status !== 'PREVIEW') return reply.code(409).send({ erro: 'Esta importação já foi confirmada.' });
    if (imp.kind === 'CLIENTES') {
      const opts = optsClientes.parse(req.body);
      const totais = await confirmarClientes(imp.id, opts);
      await log(req, 'IMPORTACAO_CLIENTES', imp.id, { arquivo: imp.fileName, modo: opts.modo, ...totais });
      return { importId: imp.id, totais };
    }
    const opts = z.object({ modo: z.enum(['SOMENTE_CRIAR', 'CRIAR_E_ATUALIZAR']), criarCadastros: z.boolean().default(false), confirmarAvisos: z.boolean().default(false) }).parse(req.body);
    const rows = await prisma.dataImportRow.findMany({ where: { importId: imp.id }, orderBy: { line: 'asc' } });

    type Res = { action: string; entity?: string; entityId?: string; previous?: Record<string, unknown>; message?: string };
    const out = new Map<string, Res>();
    const criados = { categorias: [] as string[], fornecedores: [] as string[] };
    const elegivel = (s: string) => s === 'OK' || (s === 'AVISO' && opts.confirmarAvisos);
    for (const r of rows) {
      if (r.status === 'ERRO') out.set(r.id, { action: 'ERRO' });
      else if (!elegivel(r.status)) out.set(r.id, { action: 'IGNORADO', message: 'Aviso não confirmado.' });
    }
    const dadosDe = (r: (typeof rows)[number]) => r.data as unknown as Dados;
    const pendentes = rows.filter((r) => !out.has(r.id));

    await prisma.$transaction(async (tx) => {
      const cats = await tx.category.findMany(), sups = await tx.supplier.findMany();
      const cat = async (nome: string, parentId: string | null) => {
        let c = cats.find((x) => x.parentId === parentId && norm(x.name) === norm(nome));
        if (!c && opts.criarCadastros) { c = await tx.category.create({ data: { name: nome, parentId } }); cats.push(c); criados.categorias.push(c.id); }
        return c;
      };
      const resolverCat = async (d: Dados) => { // id | null (sem categoria) | false (faltou e não pode criar)
        if (!d.categoria) return null;
        const pai = await cat(d.categoria, null);
        const c = pai && d.subcategoria ? await cat(d.subcategoria, pai.id) : pai;
        return c ? c.id : false;
      };
      const resolverFab = async (d: Dados) => {
        if (!d.fabricante) return null;
        let s = sups.find((x) => norm(x.name) === norm(d.fabricante!));
        if (!s && opts.criarCadastros) { s = await tx.supplier.create({ data: { name: d.fabricante } }); sups.push(s); criados.fornecedores.push(s.id); }
        return s ? s.id : false;
      };
      const kits: typeof rows = [];

      // Produtos primeiro, depois variações (precisam do produto-pai), depois kits (precisam dos componentes).
      for (const r of [...pendentes.filter((x) => !dadosDe(x).variacao), ...pendentes.filter((x) => dadosDe(x).variacao)]) {
        const d = dadosDe(r);
        if (d.variacao) {
          const pai = await tx.product.findFirst({ where: { sku: like(d.variacao.skuPai) } });
          if (!pai) { out.set(r.id, { action: 'ERRO', message: 'Produto-pai não foi importado.' }); continue; }
          const atual = await tx.productVariation.findFirst({ where: { sku: like(d.sku) } });
          if (atual && opts.modo === 'SOMENTE_CRIAR') { out.set(r.id, { action: 'IGNORADO', message: 'SKU já cadastrado (modo somente criar).' }); continue; }
          if (atual) {
            const data = { kind: d.variacao.tipo, value: d.variacao.valor, ...(d.custo !== undefined && { costPrice: d.custo }), ...(d.precoVenda !== undefined && { salePrice: d.precoVenda }), ...(d.estoque !== undefined && { stockQty: d.estoque }) };
            await tx.productVariation.update({ where: { id: atual.id }, data });
            out.set(r.id, { action: 'ATUALIZADO', entity: 'variation', entityId: atual.id, previous: Object.fromEntries(Object.keys(data).map((c) => [c, (atual as any)[c]])) });
          } else {
            const v = await tx.productVariation.create({ data: { productId: pai.id, sku: d.sku, kind: d.variacao.tipo, value: d.variacao.valor, costPrice: d.custo, salePrice: d.precoVenda, stockQty: d.estoque } });
            out.set(r.id, { action: 'CRIADO', entity: 'variation', entityId: v.id });
          }
          continue;
        }
        const atual = await tx.product.findFirst({ where: { sku: like(d.sku) } });
        if (atual && opts.modo === 'SOMENTE_CRIAR') { out.set(r.id, { action: 'IGNORADO', message: 'SKU já cadastrado (modo somente criar).' }); continue; }
        const categoryId = await resolverCat(d), supplierId = await resolverFab(d);
        if (categoryId === false || supplierId === false) { out.set(r.id, { action: 'IGNORADO', message: 'Categoria ou fabricante inexistente e a criação não foi autorizada.' }); continue; }
        if (atual) { // células vazias NÃO apagam dados existentes
          const data: Prisma.ProductUncheckedUpdateInput = {
            ...(d.nome && { name: d.nome }), ...(d.tipo && { type: d.tipo }), ...(d.custo !== undefined && !d.kit && { costPrice: d.custo }),
            ...(d.precoVenda !== undefined && { salePrice: d.precoVenda }), ...(d.estoque !== undefined && { stockQty: d.estoque }),
            ...(d.unidade && { unit: d.unidade }), ...(d.medidas && { dimensions: d.medidas }), ...(d.observacoes && { notes: d.observacoes }),
            ...(categoryId && { categoryId }), ...(supplierId && { supplierId }), ...(d.kit !== undefined && { isKit: d.kit }),
          };
          await tx.product.update({ where: { id: atual.id }, data });
          out.set(r.id, { action: 'ATUALIZADO', entity: 'product', entityId: atual.id, previous: Object.fromEntries(Object.keys(data).map((c) => [c, (atual as any)[c]])) });
        } else {
          const p = await tx.product.create({
            data: { sku: d.sku, name: d.nome!, type: d.tipo!, costPrice: d.custo ?? 0, salePrice: d.precoVenda!, stockQty: d.tipo === 'ENCOMENDA' ? 0 : d.estoque ?? 0, unit: d.unidade ?? 'un', dimensions: d.medidas, notes: d.observacoes, categoryId, supplierId, isKit: !!d.kit },
          });
          out.set(r.id, { action: 'CRIADO', entity: 'product', entityId: p.id });
        }
        if (d.kit) kits.push(r);
      }

      for (const r of kits) {
        const d = dadosDe(r), res = out.get(r.id)!;
        const kit = await tx.product.findFirstOrThrow({ where: { sku: like(d.sku) }, include: { kitItems: true } });
        const itens: { componentId: string; variationId: string | null; quantity: number; unitCost: number }[] = [];
        for (const c of d.componentes ?? []) {
          const prod = await tx.product.findFirst({ where: { sku: like(c.sku) } });
          const vari = prod ? null : await tx.productVariation.findFirst({ where: { sku: like(c.sku) }, include: { product: true } });
          const base = prod ?? vari?.product;
          if (!base || base.isKit) { res.message = `Kit salvo sem alterar os componentes: "${c.sku}" não está disponível.`; break; }
          itens.push({ componentId: base.id, variationId: vari?.id ?? null, quantity: c.quantidade, unitCost: Number(inherit(vari?.costPrice, base.costPrice)) });
        }
        if (res.message || !itens.length) continue;
        res.previous = { ...(res.previous ?? {}), kit: { costPrice: kit.costPrice, kitCostOverride: kit.kitCostOverride, itens: kit.kitItems.map((i) => ({ componentId: i.componentId, variationId: i.variationId, quantity: i.quantity })) } };
        await tx.kitItem.deleteMany({ where: { kitId: kit.id } });
        await tx.kitItem.createMany({ data: itens.map((i) => ({ kitId: kit.id, componentId: i.componentId, variationId: i.variationId, quantity: i.quantity })) });
        await tx.product.update({ where: { id: kit.id }, data: { costPrice: d.custo ?? kitCostCents(itens.map((i) => ({ unitCost: i.unitCost, quantity: i.quantity }))) / 100, kitCostOverride: d.custo ?? null } });
      }

      for (let i = 0; i < rows.length; i += 50)
        await Promise.all(rows.slice(i, i + 50).map((r) => {
          const x = out.get(r.id)!;
          return tx.dataImportRow.update({ where: { id: r.id }, data: { action: x.action, entity: x.entity, entityId: x.entityId, previous: x.previous ? json(x.previous) : undefined, messages: x.message ? [...(r.messages as string[]), x.message] : undefined } });
        }));
    }, { timeout: 180_000, maxWait: 10_000 });

    const cont = (a: string) => [...out.values()].filter((x) => x.action === a).length;
    const totais = { criados: cont('CRIADO'), atualizados: cont('ATUALIZADO'), ignorados: cont('IGNORADO'), erros: cont('ERRO') };
    await prisma.dataImport.update({ where: { id: imp.id }, data: { status: 'APLICADA', mode: opts.modo, totals: totais, created: criados, appliedAt: new Date() } });
    await log(req, 'IMPORTACAO_PRODUTOS', imp.id, { arquivo: imp.fileName, modo: opts.modo, ...totais });
    return { importId: imp.id, totais };
  });

  // 3) Relatório: linhas rejeitadas ou ignoradas, com o motivo.
  app.get<P>('/imports/:id/report', { preHandler: g.auth }, async (req, reply) => {
    const { formato } = formatoQ.parse(req.query);
    const rows = await prisma.dataImportRow.findMany({ where: { importId: req.params.id, OR: [{ status: 'ERRO' }, { action: { in: ['ERRO', 'IGNORADO'] } }] }, orderBy: { line: 'asc' } });
    if ((await prisma.dataImport.findUnique({ where: { id: req.params.id } }))?.kind === 'CLIENTES') {
      const porAba = (aba: string, colunas: readonly (readonly [string, string])[]) => {
        const rejeitadas = rows.filter((r) => (r.raw as { aba?: string })?.aba === aba);
        return [['Aba', 'Linha', 'Motivo', ...colunas.map(([, l]) => l)], ...rejeitadas.map((r) => [aba, r.line, (r.messages as string[]).join(' | '), ...colunas.map(([c]) => ((r.raw as { v?: Record<string, string> }).v ?? {})[c] ?? '')])] as Celula[][];
      };
      if (formato === 'csv') {
        const unidas = [['Aba', 'Linha', 'Motivo'], ...rows.map((r) => [(r.raw as { aba?: string }).aba ?? '', r.line, (r.messages as string[]).join(' | ')])] as Celula[][];
        return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="linhas_rejeitadas_clientes.csv"').send(gerarCsv(unidas));
      }
      return reply.header('Content-Type', XLSX).header('Content-Disposition', 'attachment; filename="linhas_rejeitadas_clientes.xlsx"')
        .send(await gerarXlsx([['Clientes', porAba('clientes', COLUNAS_CLIENTES)], ['Enderecos', porAba('enderecos', COLUNAS_ENDERECOS)], ['Contatos', porAba('contatos', COLUNAS_CONTATOS)]]));
    }
    const linhas: Celula[][] = [['Linha', 'Motivo', ...LABELS], ...rows.map((r) => [r.line, (r.messages as string[]).join(' | '), ...COLUNAS.map(([c]) => (r.raw as Linha)[c] ?? '')])];
    return enviar(reply, formato, 'linhas_rejeitadas', linhas, 'Rejeitadas');
  });

  app.get('/imports', { preHandler: g.auth }, async () => {
    const itens = await prisma.dataImport.findMany({ where: { status: { not: 'PREVIEW' } }, orderBy: { createdAt: 'desc' }, take: 50 });
    const users = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return itens.map((i) => ({ ...i, usuario: users.get(i.userId) ?? null }));
  });

  // 4) Desfazer a última importação (somente Admin Master): restaura valores anteriores; remove o que foi criado ou, se já estiver em uso, apenas inativa.
  app.post<P>('/imports/:id/undo', { preHandler: g.admin }, async (req, reply) => {
    const imp = await prisma.dataImport.findUnique({ where: { id: req.params.id } });
    if (!imp || imp.status !== 'APLICADA') return reply.code(409).send({ erro: 'Só é possível desfazer uma importação já aplicada.' });
    const ultima = await prisma.dataImport.findFirst({ where: { kind: imp.kind, status: 'APLICADA' }, orderBy: { appliedAt: 'desc' } });
    if (ultima?.id !== imp.id) return reply.code(409).send({ erro: 'Só é possível desfazer a última importação.' });
    if (imp.kind === 'CLIENTES') {
      const r = await desfazerClientes(imp.id);
      await prisma.dataImport.update({ where: { id: imp.id }, data: { status: 'DESFEITA', undoneAt: new Date() } });
      await log(req, 'IMPORTACAO_DESFEITA', imp.id, r);
      return r;
    }
    const rows = await prisma.dataImportRow.findMany({ where: { importId: imp.id, action: { in: ['CRIADO', 'ATUALIZADO'] } }, orderBy: { line: 'desc' } });
    const r = { removidos: 0, inativados: 0, restaurados: 0 };
    for (const row of rows) {
      const id = row.entityId!, produto = row.entity === 'product';
      if (row.action === 'ATUALIZADO') {
        const { kit, ...campos } = (row.previous ?? {}) as Record<string, any>;
        if (produto) await prisma.product.update({ where: { id }, data: campos });
        else await prisma.productVariation.update({ where: { id }, data: campos });
        if (kit) {
          await prisma.kitItem.deleteMany({ where: { kitId: id } });
          await prisma.kitItem.createMany({ data: kit.itens.map((i: any) => ({ kitId: id, componentId: i.componentId, variationId: i.variationId, quantity: i.quantity })) });
          await prisma.product.update({ where: { id }, data: { costPrice: kit.costPrice, kitCostOverride: kit.kitCostOverride } });
        }
        r.restaurados++;
      } else {
        try {
          await (produto ? prisma.product.delete({ where: { id } }) : prisma.productVariation.delete({ where: { id } }));
          r.removidos++;
        } catch (e: any) {
          if (e.code === 'P2003') {
            await (produto ? prisma.product.update({ where: { id }, data: { active: false } }) : prisma.productVariation.update({ where: { id }, data: { active: false } }));
            r.inativados++;
          } else if (e.code !== 'P2025') throw e;
        }
      }
    }
    const c = (imp.created ?? {}) as { categorias?: string[]; fornecedores?: string[] };
    for (const cid of c.categorias ?? []) await prisma.category.delete({ where: { id: cid } }).catch(() => {});
    for (const sid of c.fornecedores ?? []) await prisma.supplier.delete({ where: { id: sid } }).catch(() => {});
    await prisma.dataImport.update({ where: { id: imp.id }, data: { status: 'DESFEITA', undoneAt: new Date() } });
    await log(req, 'IMPORTACAO_DESFEITA', imp.id, r);
    return r;
  });

  // ---------- Exportação (mesmo formato do modelo, para editar e reimportar) ----------
  app.get('/exports/products', { preHandler: g.auth }, async (req, reply) => {
    const { formato } = formatoQ.parse(req.query);
    const prods = await prisma.product.findMany({
      orderBy: { sku: 'asc' },
      include: { category: { include: { parent: true } }, supplier: true, variations: true, kitItems: { include: { component: { select: { sku: true } }, variation: { select: { sku: true } } } } },
    });
    const num = (d: unknown) => (d === null || d === undefined ? '' : Number(d));
    const linhas: Celula[][] = [LABELS];
    for (const p of prods) {
      linhas.push([
        p.sku, p.name, p.category?.parent?.name ?? p.category?.name ?? '', p.category?.parent ? p.category.name : '', p.supplier?.name ?? '',
        p.type === 'PRONTA_ENTREGA' ? 'Pronta entrega' : 'Encomenda', p.isKit ? num(p.kitCostOverride) : num(p.costPrice), num(p.salePrice), p.stockQty, p.unit, p.dimensions ?? '',
        '', '', '', p.isKit ? 'Sim' : 'Não', p.kitItems.map((i) => `${i.variation?.sku ?? i.component.sku}:${i.quantity}`).join('; '), p.notes ?? '',
      ]);
      for (const v of p.variations) linhas.push([v.sku, '', '', '', '', '', num(v.costPrice), num(v.salePrice), num(v.stockQty), '', '', v.kind, v.value, p.sku, '', '', '']);
    }
    await audit({ userId: req.user.sub, action: 'EXPORTACAO_PRODUTOS', entity: 'product', after: { linhas: linhas.length - 1, formato }, ip: req.ip });
    return enviar(reply, formato, 'produtos', linhas, 'Produtos');
  });

  // ---------- Exportação de clientes (mesmo formato do modelo, para editar e reimportar) ----------
  app.get('/exports/customers', { preHandler: g.auth }, async (req, reply) => {
    const { formato } = formatoQ.parse(req.query);
    const clientes = await prisma.customer.findMany({ where: { archived: false }, orderBy: { name: 'asc' }, include: { addresses: true, contacts: true } });
    const simNao = (b: boolean) => (b ? 'Sim' : 'Não');
    const dataBr = (d: Date | null) => (d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '');
    const cepFmt = (c: string | null) => (c ? c.replace(/(\d{5})(\d{3})/, '$1-$2') : '');
    const linhasClientes: Celula[][] = [
      COLUNAS_CLIENTES.map(([, l]) => l),
      ...clientes.map((c) => [
        c.personType === 'FISICA' ? 'Física' : 'Jurídica', c.priceList === 'PADRAO' ? 'Padrão' : 'Bloqueado', c.name, c.nickname ?? '',
        formatarDocumento(c.document), c.rg ?? '', c.rgIssuer ?? '', c.rgUf ?? '', c.gender === 'M' ? 'Masculino' : c.gender === 'F' ? 'Feminino' : '',
        dataBr(c.birthDate), c.phone ?? '', c.mobile ?? '', c.email ?? '', c.website ?? '', c.notes ?? '',
        c.creditLimit !== null ? Number(c.creditLimit) : '', c.nfeEmail ?? '', simNao(c.issWithheld), simNao(c.consumerFinal), simNao(c.ruralProducer),
      ]),
    ];
    if (formato === 'csv') {
      await audit({ userId: req.user.sub, action: 'EXPORTACAO_CLIENTES', entity: 'customer', after: { linhas: clientes.length, formato }, ip: req.ip });
      return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="clientes.csv"').send(gerarCsv(linhasClientes));
    }
    const linhasEnderecos: Celula[][] = [
      COLUNAS_ENDERECOS.map(([, l]) => l),
      ...clientes.flatMap((c) => c.addresses.map((a) => [
        formatarDocumento(c.document), a.isForeign ? '' : cepFmt(a.zipCode), a.street, a.number ?? '', a.complement ?? '', a.district ?? '',
        a.city ?? '', a.state ?? '', simNao(a.isForeign), simNao(a.isMain),
      ])),
    ];
    const linhasContatos: Celula[][] = [
      COLUNAS_CONTATOS.map(([, l]) => l),
      ...clientes.flatMap((c) => c.contacts.map((ct) => [formatarDocumento(c.document), ct.name, ct.phone ?? '', ct.email ?? '', ct.notes ?? ''])),
    ];
    await audit({ userId: req.user.sub, action: 'EXPORTACAO_CLIENTES', entity: 'customer', after: { linhas: clientes.length, formato }, ip: req.ip });
    return reply.header('Content-Type', XLSX).header('Content-Disposition', 'attachment; filename="clientes.xlsx"')
      .send(await gerarXlsx([['Clientes', linhasClientes], ['Enderecos', linhasEnderecos], ['Contatos', linhasContatos]]));
  });
}
