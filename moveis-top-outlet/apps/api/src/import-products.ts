export const COLUNAS = [
  ['sku', 'SKU'], ['nome', 'Nome'], ['categoria', 'Categoria'], ['subcategoria', 'Subcategoria'], ['fabricante', 'Fabricante'],
  ['tipo', 'Tipo'], ['custo', 'Custo'], ['preco_venda', 'Preço de venda'], ['estoque', 'Estoque'], ['unidade', 'Unidade'],
  ['medidas', 'Medidas'], ['variacao_tipo', 'Variação tipo'], ['variacao_valor', 'Variação valor'], ['sku_pai', 'SKU do produto-pai'],
  ['kit', 'Kit'], ['componentes_kit', 'Componentes do kit'], ['observacoes', 'Observações'],
] as const;
export type Chave = (typeof COLUNAS)[number][0];
export type Linha = Partial<Record<Chave, string>>;
export type Entrada = { linha: number; v: Linha };

export const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIAS: Record<string, Chave> = { codigo: 'sku', produto: 'nome', fornecedor: 'fabricante', preco: 'preco_venda', precovenda: 'preco_venda', skupai: 'sku_pai', componentes: 'componentes_kit', observacao: 'observacoes' };
const POR_NOME = new Map<string, Chave>(COLUNAS.flatMap(([c, l]) => [[norm(c), c], [norm(l), c]] as [string, Chave][]));
export const mapHeader = (h: string): Chave | null => POR_NOME.get(norm(h)) ?? ALIAS[norm(h)] ?? null;

/** undefined = vazio, null = inválido. Aceita "1.234,56", "1234.56" e "R$ 10,00". */
export function parseMoney(v?: string): number | null | undefined {
  let s = v?.trim().replace(/[R$\s]/g, '');
  if (!s) return undefined;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  return /^\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) / 100 : null;
}
export function parseInteiro(v?: string): number | null | undefined {
  const s = v?.trim().replace(/\.0+$/, '');
  return !s ? undefined : /^\d+$/.test(s) ? Number(s) : null;
}
export function parseSimNao(v?: string): boolean | null | undefined {
  const n = norm(v ?? '');
  if (!n) return undefined;
  return ['sim', 's', 'x', '1', 'true'].includes(n) ? true : ['nao', 'n', '0', 'false'].includes(n) ? false : null;
}
export function parseTipo(v?: string): 'PRONTA_ENTREGA' | 'ENCOMENDA' | null | undefined {
  const n = norm(v ?? '');
  if (!n) return undefined;
  return ['prontaentrega', 'pronta', 'pe', 'estoque'].includes(n) ? 'PRONTA_ENTREGA' : ['encomenda', 'sobencomenda', 'se'].includes(n) ? 'ENCOMENDA' : null;
}
/** "COZ-01:1; ARM-02:2" → lista. Sem ":qtd" vale 1. null = inválido. */
export function parseComponentes(v?: string) {
  const out: { sku: string; quantidade: number }[] = [];
  for (const e of (v ?? '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean)) {
    const [sku, q] = e.split(':').map((x) => x.trim());
    const quantidade = q === undefined ? 1 : Number(q);
    if (!sku || !Number.isInteger(quantidade) || quantidade < 1) return null;
    out.push({ sku, quantidade });
  }
  return out;
}

export type Ctx = {
  dbSkus: Map<string, 'produto' | 'variacao'>; // chaves em minúsculas
  dbKits: Set<string>;
  categorias: Set<string>;
  subcategorias: Set<string>; // "categoria/subcategoria" normalizado
  fabricantes: Set<string>;
};
export type Dados = {
  sku: string; nome?: string; categoria?: string; subcategoria?: string; fabricante?: string; tipo?: 'PRONTA_ENTREGA' | 'ENCOMENDA';
  custo?: number; precoVenda?: number; estoque?: number; unidade?: string; medidas?: string; observacoes?: string;
  variacao?: { tipo: string; valor: string; skuPai: string }; kit?: boolean; componentes?: { sku: string; quantidade: number }[];
};
export type Resultado = { linha: number; status: 'OK' | 'AVISO' | 'ERRO'; mensagens: string[]; dados?: Dados };

const k = (s?: string) => (s ?? '').trim().toLowerCase();
const txt = (s?: string) => s?.trim() || undefined;

export function validar(entradas: Entrada[], ctx: Ctx): Resultado[] {
  const planilha = new Map<string, { linha: number; kit: boolean; variacao: boolean }>();
  for (const { linha, v } of entradas)
    if (k(v.sku) && !planilha.has(k(v.sku))) planilha.set(k(v.sku), { linha, kit: parseSimNao(v.kit) === true, variacao: !!txt(v.sku_pai) });

  return entradas.map(({ linha, v }) => {
    const erros: string[] = [], avisos: string[] = [], infos: string[] = [];
    const sku = txt(v.sku) ?? '';
    const primeira = planilha.get(k(sku));
    if (!sku) erros.push('SKU em branco.');
    else if (primeira && primeira.linha !== linha) erros.push(`SKU repetido na planilha (já aparece na linha ${primeira.linha}).`);
    const existente = ctx.dbSkus.get(k(sku));
    const dinheiro = (c: Chave, nome: string) => { const x = parseMoney(v[c]); if (x === null) erros.push(`${nome} inválido.`); return x ?? undefined; };
    const custo = dinheiro('custo', 'Custo'), precoVenda = dinheiro('preco_venda', 'Preço de venda');
    const estoque = parseInteiro(v.estoque);
    if (estoque === null) erros.push('Estoque inválido (use número inteiro).');
    const dados: Dados = { sku, custo, precoVenda, estoque: estoque ?? undefined };

    const skuPai = txt(v.sku_pai);
    if (skuPai) {
      const pai = planilha.get(k(skuPai));
      if (ctx.dbSkus.get(k(skuPai)) !== 'produto' && !(pai && !pai.variacao)) erros.push(`Produto-pai "${skuPai}" não encontrado.`);
      if (existente === 'produto') erros.push('Este SKU já pertence a um produto, não a uma variação.');
      if (!txt(v.variacao_tipo) || !txt(v.variacao_valor)) erros.push('Informe o tipo e o valor da variação.');
      dados.variacao = { tipo: txt(v.variacao_tipo) ?? '', valor: txt(v.variacao_valor) ?? '', skuPai };
    } else {
      if (existente === 'variacao') erros.push('Este SKU já pertence a uma variação.');
      const tipo = parseTipo(v.tipo), kit = parseSimNao(v.kit);
      if (tipo === null) erros.push('Tipo inválido (use "pronta entrega" ou "encomenda").');
      if (kit === null) erros.push('Kit deve ser "sim" ou "não".');
      if (!existente) {
        if (!txt(v.nome)) erros.push('Nome obrigatório para produto novo.');
        if (tipo === undefined) erros.push('Tipo obrigatório para produto novo.');
        if (precoVenda === undefined) erros.push('Preço de venda obrigatório para produto novo.');
        if (custo === undefined && !kit) erros.push('Custo obrigatório para produto novo.');
      } else if (existente === 'produto') infos.push('SKU já cadastrado: será atualizado ou ignorado, conforme o modo escolhido.');
      Object.assign(dados, { nome: txt(v.nome), categoria: txt(v.categoria), subcategoria: txt(v.subcategoria), fabricante: txt(v.fabricante), tipo: tipo ?? undefined, unidade: txt(v.unidade), medidas: txt(v.medidas), observacoes: txt(v.observacoes), kit: kit ?? undefined });
      const { categoria: c, subcategoria: s, fabricante: f } = dados;
      if (s && !c) erros.push('Subcategoria informada sem categoria.');
      else if (c && !ctx.categorias.has(norm(c))) avisos.push(`Categoria "${c}" não existe e será criada.`);
      else if (c && s && !ctx.subcategorias.has(`${norm(c)}/${norm(s)}`)) avisos.push(`Subcategoria "${s}" não existe e será criada.`);
      if (f && !ctx.fabricantes.has(norm(f))) avisos.push(`Fabricante "${f}" não existe e será criado.`);
      if (custo !== undefined && precoVenda !== undefined && custo > precoVenda) avisos.push('Custo maior que o preço de venda (margem negativa).');
      if (tipo === 'ENCOMENDA' && (estoque ?? 0) > 0) avisos.push('Estoque será ignorado em produto sob encomenda.');
      if (kit) {
        const comps = parseComponentes(v.componentes_kit);
        if (!comps?.length) erros.push('Kit precisa de componentes no formato "SKU:quantidade; SKU:quantidade".');
        for (const c of comps ?? []) {
          const ch = k(c.sku), naPlan = planilha.get(ch);
          if (ctx.dbKits.has(ch) || naPlan?.kit) erros.push(`Componente "${c.sku}" é um kit; um kit não pode conter outro kit.`);
          else if (!ctx.dbSkus.has(ch) && !naPlan) erros.push(`Componente "${c.sku}" não encontrado.`);
        }
        dados.componentes = comps ?? undefined;
      }
    }
    const status = erros.length ? 'ERRO' : avisos.length ? 'AVISO' : 'OK';
    return { linha, status, mensagens: [...erros, ...avisos, ...infos], dados: erros.length ? undefined : dados } as Resultado;
  });
}
