import { describe, expect, it } from 'vitest';
import { buildTree, descendantIds, inherit, kitCostCents, wouldCycle } from './catalog-utils.js';

const cats = [
  { id: 'a', name: 'Sala', parentId: null },
  { id: 'b', name: 'Estofados', parentId: 'a' },
  { id: 'c', name: 'Poltronas', parentId: 'b' },
  { id: 'd', name: 'Cozinha', parentId: null },
];

describe('categorias', () => {
  it('monta a árvore', () => {
    const t = buildTree(cats);
    expect(t.map((n) => n.id)).toEqual(['a', 'd']);
    expect(t[0].children[0].children[0].id).toBe('c');
  });
  it('lista subcategorias', () => expect(descendantIds(cats, 'a').sort()).toEqual(['a', 'b', 'c']));
  it('impede ciclo ao mover', () => {
    expect(wouldCycle(cats, 'a', 'c')).toBe(true);
    expect(wouldCycle(cats, 'c', 'd')).toBe(false);
    expect(wouldCycle(cats, 'c', null)).toBe(false);
  });
});

describe('custo do kit e herança', () => {
  it('soma custo × quantidade em centavos', () =>
    expect(kitCostCents([{ unitCost: 199.9, quantity: 2 }, { unitCost: 0.1, quantity: 3 }])).toBe(40010));
  it('usa o valor sobrescrito, inclusive zero', () => {
    expect(kitCostCents([{ unitCost: 100, quantity: 1 }], 80)).toBe(8000);
    expect(kitCostCents([{ unitCost: 100, quantity: 1 }], 0)).toBe(0);
  });
  it('variação herda do produto-pai só quando vazia', () => {
    expect(inherit(null, 50)).toBe(50);
    expect(inherit(0, 50)).toBe(0);
    expect(inherit(70, 50)).toBe(70);
  });
});
