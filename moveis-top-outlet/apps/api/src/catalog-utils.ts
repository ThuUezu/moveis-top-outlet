export type Cat = { id: string; name: string; parentId: string | null };
export type CatNode<T extends Cat> = T & { children: CatNode<T>[] };

export function buildTree<T extends Cat>(cats: T[]): CatNode<T>[] {
  const nodes = new Map(cats.map((c) => [c.id, { ...c, children: [] as CatNode<T>[] }]));
  const roots: CatNode<T>[] = [];
  for (const n of nodes.values()) (n.parentId && nodes.get(n.parentId) ? nodes.get(n.parentId)!.children : roots).push(n);
  return roots;
}

/** A própria categoria e todas as subcategorias abaixo dela. */
export function descendantIds(cats: Cat[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of cats) if (c.parentId === out[i]) out.push(c.id);
  return out;
}

/** Verdadeiro se mover `id` para baixo de `newParentId` criaria um ciclo na árvore. */
export const wouldCycle = (cats: Cat[], id: string, newParentId: string | null) =>
  newParentId !== null && descendantIds(cats, id).includes(newParentId);

export const toCents = (v: number | string) => Math.round(Number(v) * 100);

/** Custo do kit em centavos: soma (custo × quantidade) dos componentes, ou o valor sobrescrito. */
export function kitCostCents(items: { unitCost: number | string; quantity: number }[], override?: number | string | null) {
  if (override !== null && override !== undefined) return toCents(override);
  return items.reduce((sum, i) => sum + toCents(i.unitCost) * i.quantity, 0);
}

/** Variação herda do produto-pai quando o campo está vazio (zero é um valor válido). */
export const inherit = <T>(own: T | null | undefined, parent: T): T => own ?? parent;
