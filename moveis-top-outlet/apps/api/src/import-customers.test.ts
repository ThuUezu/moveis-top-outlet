import { describe, expect, it } from 'vitest';
import { mapHeaderCliente, parseCep, parseDataBr, validarClientes, type EntradaC, type LinhaClientes, type LinhaEnderecos } from './import-customers.js';

const CPF = '52998224725';
const CNPJ = '11222333000181';
const linhas = <T extends Record<string, string>>(ls: T[]): EntradaC<T>[] => ls.map((v, i) => ({ linha: i + 2, v }));
const base: LinhaClientes = { nome: 'Maria Silva', cpf_cnpj: '529.982.247-25', tipo_pessoa: 'Física', aniversario: '15/03/1990' };

describe('parsing dos campos', () => {
  it('data dd/mm/aaaa validada; dia inexistente é inválido', () => {
    expect(parseDataBr('29/02/2024')).toBeInstanceOf(Date);
    expect(parseDataBr('29/02/2023')).toBeNull();
    expect(parseDataBr('2024-02-29')).toBeNull();
    expect(parseDataBr('')).toBeUndefined();
  });
  it('CEP com ou sem pontuação; máscara de cabeçalhos', () => {
    expect(parseCep('01310-100')).toBe('01310100');
    expect(parseCep('123')).toBeNull();
    expect(mapHeaderCliente('CPF/CNPJ')).toBe('cpf_cnpj');
    expect(mapHeaderCliente('Lista de preços')).toBe('tipo_lista_preco');
    expect(mapHeaderCliente('???')).toBeNull();
  });
});

describe('validação das linhas de clientes (seção 10-B)', () => {
  const ctxDb = new Set<string>();
  const rodar = (c: LinhaClientes[], e: LinhaEnderecos[] = []) =>
    validarClientes({ clientes: linhas(c), enderecos: linhas(e), contatos: [] }, ctxDb);

  it('cliente completo é OK; nome e documento obrigatórios', () => {
    expect(rodar([base]).clientes[0].status).toBe('OK');
    expect(rodar([{ cpf_cnpj: CPF }]).clientes[0].mensagens.join()).toContain('Nome obrigatório');
    expect(rodar([{ nome: 'X' }]).clientes[0].status).toBe('ERRO');
  });
  it('CPF/CNPJ com dígitos verificadores inválidos é erro', () => {
    const r = rodar([{ ...base, cpf_cnpj: '111.111.111-11' }]).clientes[0];
    expect(r.status).toBe('ERRO');
    expect(r.mensagens.join()).toContain('inválido');
  });
  it('PJ com CNPJ válido é OK', () => {
    expect(rodar([{ nome: 'Loja Ltda', cpf_cnpj: '11.222.333/0001-81', tipo_pessoa: 'jurídica' }]).clientes[0].status).toBe('OK');
  });
  it('campos opcionais malformados viram erro na linha', () => {
    const r = rodar([{ ...base, email: 'nao-e-email', limite_credito: 'abc', sexo: 'X', uf_emissor: 'ZZ' }]).clientes[0];
    expect(r.status).toBe('ERRO');
    const t = r.mensagens.join();
    expect(t).toContain('E-mail inválido');
    expect(t).toContain('Limite de crédito inválido');
    expect(t).toContain('Sexo inválido');
    expect(t).toContain('UF emissor inválida');
  });
  it('valores monetários aceitam vírgula ou ponto', () => {
    expect(rodar([{ ...base, limite_credito: '1.500,50' }]).clientes[0].status).toBe('OK');
  });
  it('campos Sim/Não aceitam variações comuns', () => {
    const r = rodar([{ ...base, consumidor_final: 's', produtor_rural: 'x', iss_retido_fonte: 'NÃO' }]).clientes[0];
    expect(r.status).toBe('OK');
    expect(r.dados!.consumidorFinal).toBe(true);
    expect(r.dados!.produtorRural).toBe(true);
    expect(r.dados!.issRetido).toBe(false);
  });
  it('CPF repetido na planilha: segunda linha é erro', () => {
    const r = rodar([base, { ...base, nome: 'Outra Maria' }]);
    expect([r.clientes[0].status, r.clientes[1].status]).toEqual(['OK', 'ERRO']);
  });
  it('cliente já existente no banco é marcado', () => {
    const r = validarClientes({ clientes: linhas([base]), enderecos: [], contatos: [] }, new Set([CPF]));
    expect(r.clientes[0].existente).toBe(true);
  });
});

describe('validação de endereços', () => {
  const rodar = (c: LinhaClientes[], e: LinhaEnderecos[]) =>
    validarClientes({ clientes: linhas(c), enderecos: linhas(e), contatos: [] }, new Set());

  it('endereço vinculado ao cliente da planilha é OK', () => {
    const r = rodar([base], [{ cpf_cnpj: CPF, cep: '01310-100', endereco: 'Av. Paulista', numero: '1000', cidade: 'São Paulo', uf: 'SP', principal: 'Sim' }]);
    expect(r.enderecos[0].status).toBe('OK');
    expect(r.enderecos[0].dados!.principal).toBe(true);
  });
  it('endereço de cliente inexistente (planilha e banco) é erro', () => {
    const r = rodar([base], [{ cpf_cnpj: CNPJ, endereco: 'Rua X' }]);
    expect(r.enderecos[0].status).toBe('ERRO');
    expect(r.enderecos[0].mensagens.join()).toContain('não existe');
  });
  it('exterior aceita endereço livre sem CEP; CEP fora disso é validado', () => {
    const r = rodar([base], [
      { cpf_cnpj: CPF, endereco_exterior: 'Sim', endereco: '123 Main St, Miami' },
      { cpf_cnpj: CPF, cep: '123' },
    ]);
    expect(r.enderecos[0].status).toBe('OK');
    expect(r.enderecos[1].mensagens.join()).toContain('CEP inválido');
  });
  it('endereço sem CEP gera aviso (confirmação automática indisponível)', () => {
    const r = rodar([base], [{ cpf_cnpj: CPF, endereco: 'Rua das Flores' }]);
    expect(r.enderecos[0].status).toBe('AVISO');
  });
});
