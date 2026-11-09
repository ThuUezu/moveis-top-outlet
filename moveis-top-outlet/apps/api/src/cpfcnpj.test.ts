import { describe, expect, it } from 'vitest';
import { classificarDocumento, formatarDocumento, mascararDocumento, normalizarDocumento, soDigitos, validarCnpj, validarCpf, validarUf } from './cpfcnpj.js';

// CPF e CNPJ gerados como "válidos" (dígitos verificadores corretos) para os testes.
const CPF_VALIDO = '52998224725'; // dígito verificador conferido
const CNPJ_VALIDO = '11222333000181'; // dígito verificador conferido

describe('normalização e classificação', () => {
  it('remove pontuação e classifica por tamanho', () => {
    expect(soDigitos('529.982.247-25')).toBe(CPF_VALIDO);
    expect(classificarDocumento('529.982.247-25')).toBe('CPF');
    expect(classificarDocumento('11.222.333/0001-81')).toBe('CNPJ');
    expect(classificarDocumento('123')).toBeNull();
  });
  it('normalizar aceita com ou sem pontuação', () => {
    expect(normalizarDocumento('52998224725')).toBe(CPF_VALIDO);
    expect(normalizarDocumento('11.222.333/0001-81')).toBe(CNPJ_VALIDO);
  });
});

describe('validação dos dígitos verificadores (seção 10-B)', () => {
  it('CPF válido passa; inválido e repetido não', () => {
    expect(validarCpf(CPF_VALIDO)).toBe(true);
    expect(validarCpf('52998224726')).toBe(false);
    expect(validarCpf('11111111111')).toBe(false);
    expect(validarCpf('5299822472')).toBe(false); // 10 dígitos
  });
  it('CNPJ válido passa; inválido e repetido não', () => {
    expect(validarCnpj(CNPJ_VALIDO)).toBe(true);
    expect(validarCnpj('11222333000182')).toBe(false);
    expect(validarCnpj('11111111000111')).toBe(false);
    expect(validarCnpj('1122233300018')).toBe(false); // 13 dígitos
  });
  it('normalizar devolve null quando inválido', () => {
    expect(normalizarDocumento('111.111.111-11')).toBeNull();
    expect(normalizarDocumento('529.982.247-26')).toBeNull();
    expect(normalizarDocumento('')).toBeNull();
    expect(normalizarDocumento('abc')).toBeNull();
  });
});

describe('máscara e formatação (LGPD)', () => {
  it('mascarar guarda só início e fim', () => {
    expect(mascararDocumento(CPF_VALIDO)).toBe('529.***.***-25');
    expect(mascararDocumento(CNPJ_VALIDO)).toBe('112.***.***-81');
  });
  it('formatar aplica pontuação', () => {
    expect(formatarDocumento(CPF_VALIDO)).toBe('529.982.247-25');
    expect(formatarDocumento(CNPJ_VALIDO)).toBe('11.222.333/0001-81');
  });
  it('UF válida', () => {
    expect(validarUf('sp')).toBe(true);
    expect(validarUf('SP')).toBe(true);
    expect(validarUf('XX')).toBe(false);
  });
});
