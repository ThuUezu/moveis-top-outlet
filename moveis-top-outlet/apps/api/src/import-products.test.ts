import { describe, expect, it } from 'vitest';
import { parseComponentes, parseMoney, parseSimNao, parseTipo, validar, type Ctx, type Linha } from './import-products.js';

describe('leitura de valores', () => {
  it('dinheiro com vírgula ou ponto', () => {
    expect(parseMoney('1.234,56')).toBe(1234.56);
    expect(parseMoney('R$ 10,5')).toBe(10.5);
    expect(parseMoney('1234.56')).toBe(1234.56);
    expect(parseMoney('')).toBeUndefined();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
  });
  it('sim/não, tipo e componentes', () => {
    expect(parseSimNao('S')).toBe(true);
    expect(parseSimNao('Não')).toBe(false);
    expect(parseTipo('Sob encomenda')).toBe('ENCOMENDA');
    expect(parseTipo('Pronta Entrega')).toBe('PRONTA_ENTREGA');
    expect(parseComponentes('COZ-01:1; ARM-02:2')).toEqual([{ sku: 'COZ-01', quantidade: 1 }, { sku: 'ARM-02', quantidade: 2 }]);
    expect(parseComponentes('COZ-01:0')).toBeNull();
  });
});

const ctx: Ctx = { dbSkus: new Map([['sof-1', 'produto']]), dbKits: new Set(), categorias: new Set(['sala']), subcategorias: new Set(), fabricantes: new Set() };
const rodar = (ls: Linha[]) => validar(ls.map((v, i) => ({ linha: i + 2, v })), ctx);
const novo: Linha = { sku: 'MESA-1', nome: 'Mesa', tipo: 'encomenda', custo: '100', preco_venda: '200' };

describe('validação das linhas', () => {
  it('produto novo completo é OK; categoria nova gera aviso', () => {
    expect(rodar([novo])[0].status).toBe('OK');
    expect(rodar([{ ...novo, categoria: 'Jardim' }])[0].status).toBe('AVISO');
  });
  it('produto novo sem preço é erro; SKU existente só precisa do que muda', () => {
    expect(rodar([{ sku: 'X', nome: 'X', tipo: 'encomenda', custo: '1' }])[0].status).toBe('ERRO');
    expect(rodar([{ sku: 'SOF-1', preco_venda: '10' }])[0].status).toBe('OK');
  });
  it('SKU repetido na planilha: só a segunda linha é erro', () => {
    const r = rodar([novo, novo]);
    expect([r[0].status, r[1].status]).toEqual(['OK', 'ERRO']);
  });
  it('variação exige produto-pai existente (no banco ou na planilha)', () => {
    const v: Linha = { sku: 'MESA-1-AZ', sku_pai: 'MESA-1', variacao_tipo: 'Cor', variacao_valor: 'Azul' };
    expect(rodar([novo, v])[1].status).toBe('OK');
    expect(rodar([v])[0].status).toBe('ERRO');
  });
  it('kit precisa de componentes que existam', () => {
    const kit: Linha = { sku: 'KIT-1', nome: 'Kit', tipo: 'encomenda', preco_venda: '500', kit: 'sim', componentes_kit: 'SOF-1:1; NADA:1' };
    expect(rodar([kit])[0].mensagens.join()).toContain('"NADA" não encontrado');
  });
});
