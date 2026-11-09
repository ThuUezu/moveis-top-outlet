import ExcelJS from 'exceljs';
import { mapHeader, type Entrada, type Linha } from './import-products.js';

export class ErroPlanilha extends Error {}
export type Celula = string | number;

const celula = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toLocaleDateString('pt-BR');
  if (typeof v === 'object') { const o = v as any; return String(o.result ?? o.text ?? o.richText?.map((r: any) => r.text).join('') ?? ''); }
  return String(v);
};
const decodificar = (b: Buffer) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^\uFEFF/, ''); } catch { return new TextDecoder('latin1').decode(b); }
};
function lerCsv(text: string): string[][] {
  const topo = text.split(/\r?\n/)[0] ?? '';
  const sep = (topo.match(/;/g)?.length ?? 0) >= (topo.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], f = '', aspas = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (aspas) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else aspas = false; } else f += c; }
    else if (c === '"') aspas = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** Lê .xlsx ou .csv (UTF-8 ou Latin-1) e devolve as linhas com o número da linha original. */
export async function lerPlanilha(buf: Buffer, fileName: string): Promise<Entrada[]> {
  const grid: { n: number; c: string[] }[] = [];
  try {
    if (/\.xlsx$/i.test(fileName)) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as any);
      const ws = wb.worksheets[0];
      ws?.eachRow((r, n) => grid.push({ n, c: Array.from({ length: ws.columnCount }, (_, i) => celula(r.getCell(i + 1).value)) }));
    } else if (/\.csv$/i.test(fileName)) lerCsv(decodificar(buf)).forEach((c, i) => grid.push({ n: i + 1, c }));
    else throw new ErroPlanilha('Envie um arquivo .xlsx ou .csv.');
  } catch (e) {
    throw e instanceof ErroPlanilha ? e : new ErroPlanilha('Não foi possível ler o arquivo. Confira se é um .xlsx ou .csv válido.');
  }
  const [cab, ...corpo] = grid;
  const chaves = (cab?.c ?? []).map(mapHeader);
  if (!chaves.includes('sku')) throw new ErroPlanilha('Não encontrei a coluna "SKU". Baixe o modelo e use as colunas dele.');
  return corpo.filter((r) => r.c.some((x) => x.trim())).map((r) => {
    const v: Linha = {};
    chaves.forEach((c, i) => { if (c && r.c[i]?.trim()) v[c] = r.c[i].trim(); });
    return { linha: r.n, v };
  });
}

const normAba = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Lê um .xlsx com várias abas e devolve, para cada aba, as linhas mapeadas por cabeçalho. */
export async function lerAbas<K extends string>(buf: Buffer, fileName: string, mapHeader: (h: string) => K | null): Promise<Map<string, { linha: number; v: Partial<Record<K, string>> }[]>> {
  if (!/\.xlsx$/i.test(fileName)) throw new ErroPlanilha('Para importar clientes com endereços e contatos, use um arquivo .xlsx (o modelo tem 3 abas).');
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
  } catch {
    throw new ErroPlanilha('Não foi possível ler o arquivo. Confira se é um .xlsx válido.');
  }
  const abas = new Map<string, { linha: number; v: Partial<Record<K, string>> }[]>();
  for (const ws of wb.worksheets) {
    const grid: { n: number; c: string[] }[] = [];
    ws.eachRow((r, n) => grid.push({ n, c: Array.from({ length: ws.columnCount }, (_, i) => celula(r.getCell(i + 1).value)) }));
    const [cab, ...corpo] = grid;
    const chaves = (cab?.c ?? []).map(mapHeader);
    const entradas = corpo.filter((r) => r.c.some((x) => x.trim())).map((r) => {
      const v = {} as Partial<Record<K, string>>;
      chaves.forEach((c, i) => { if (c && r.c[i]?.trim()) v[c] = r.c[i].trim(); });
      return { linha: r.n, v };
    });
    if (entradas.length) abas.set(normAba(ws.name), entradas);
  }
  if (!abas.size) throw new ErroPlanilha('A planilha não tem linhas de dados.');
  return abas;
}

// Evita que o Excel execute texto que começa com = + - @ (injeção de fórmula).
const seguro = (c: Celula) => (typeof c === 'string' && /^[=+\-@]/.test(c) ? `'${c}` : c);

export async function gerarXlsx(abas: [string, Celula[][]][]) {
  const wb = new ExcelJS.Workbook();
  for (const [nome, linhas] of abas) {
    const ws = wb.addWorksheet(nome);
    ws.addRows(linhas.map((l) => l.map(seguro)));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 22));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
export const gerarCsv = (linhas: Celula[][]) =>
  '\uFEFF' + linhas.map((l) => l.map((c) => { const s = String(seguro(c) ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(';')).join('\r\n');
