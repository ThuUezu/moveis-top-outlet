/** CPF/CNPJ: normalização, validação (dígitos verificadores), máscara e formatação. */

export const soDigitos = (v: string) => v.replace(/\D/g, '');

const REPETIDO = (d: string) => /^(\d)\1+$/.test(d);

/** Valida os dígitos verificadores de um CPF de 11 dígitos. */
export function validarCpf(d: string): boolean {
  if (d.length !== 11 || REPETIDO(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  let r = (s * 10) % 11;
  if (r === 10) r = 0;
  if (r !== Number(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * (11 - i);
  r = (s * 10) % 11;
  if (r === 10) r = 0;
  return r === Number(d[10]);
}

/** Valida os dígitos verificadores de um CNPJ de 14 dígitos. */
export function validarCnpj(d: string): boolean {
  if (d.length !== 14 || REPETIDO(d)) return false;
  const calc = (base: string, pesos: number[]) => {
    const s = base.split('').reduce((acc, c, i) => acc + Number(c) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  if (calc(d.slice(0, 12), p1) !== Number(d[12])) return false;
  const p2 = [6, ...p1];
  return calc(d.slice(0, 13), p2) === Number(d[13]);
}

/** Classifica o valor como CPF ou CNPJ com base no tamanho e na validade. */
export function classificarDocumento(v: string): 'CPF' | 'CNPJ' | null {
  const d = soDigitos(v);
  if (d.length === 11 && validarCpf(d)) return 'CPF';
  if (d.length === 14 && validarCnpj(d)) return 'CNPJ';
  return null;
}

/** Normaliza para somente dígitos se válido; senão, null. Aceita com ou sem pontuação. */
export const normalizarDocumento = (v: string): string | null => {
  const d = soDigitos(v);
  return d.length === 11 ? (validarCpf(d) ? d : null) : d.length === 14 ? (validarCnpj(d) ? d : null) : null;
};

export const formatarDocumento = (d: string) =>
  d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

/** Máscara para listagens e logs (LGPD): guarda só o início e o fim. */
export const mascararDocumento = (d: string) => (d.length < 4 ? '***' : `${d.slice(0, 3)}.***.***-${d.slice(-2)}`);

export const mascararEmail = (e: string) => { const [a, dominio] = e.split('@'); return `${a.slice(0, 2)}***@${dominio ?? ''}`; };
export const mascararTelefone = (t: string) => { const d = soDigitos(t); return d.length < 4 ? '***' : `(**) *****-${d.slice(-4)}`; };

/** Unidades federativas válidas. */
export const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
export const validarUf = (uf: string) => UFS.has(uf.trim().toUpperCase());
