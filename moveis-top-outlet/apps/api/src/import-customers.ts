import { mascararDocumento, normalizarDocumento, soDigitos, validarUf } from './cpfcnpj.js';
import { norm, parseMoney, parseSimNao } from './import-products.js';

export const ABAS = { CLIENTES: 'Clientes', ENDERECOS: 'Enderecos', CONTATOS: 'Contatos' } as const;

export const COLUNAS_CLIENTES = [
  ['tipo_pessoa', 'Tipo de pessoa'], ['tipo_lista_preco', 'Lista de preços'], ['nome', 'Nome'], ['apelido', 'Apelido'],
  ['cpf_cnpj', 'CPF/CNPJ'], ['rg', 'RG'], ['emissor', 'Emissor'], ['uf_emissor', 'UF emissor'], ['sexo', 'Sexo'],
  ['aniversario', 'Aniversário'], ['telefone', 'Telefone'], ['celular', 'Celular'], ['email', 'E-mail'], ['site', 'Site'],
  ['observacao', 'Observação'], ['limite_credito', 'Limite de crédito'], ['email_destinatario_nfe', 'E-mail NFe'],
  ['iss_retido_fonte', 'ISS retido'], ['consumidor_final', 'Consumidor final'], ['produtor_rural', 'Produtor rural'],
] as const;
export const COLUNAS_ENDERECOS = [
  ['cpf_cnpj', 'CPF/CNPJ'], ['cep', 'CEP'], ['endereco', 'Endereço'], ['numero', 'Número'], ['complemento', 'Complemento'],
  ['bairro', 'Bairro'], ['cidade', 'Cidade'], ['uf', 'UF'], ['endereco_exterior', 'Endereço no exterior'], ['principal', 'Principal'],
] as const;
export const COLUNAS_CONTATOS = [
  ['cpf_cnpj', 'CPF/CNPJ'], ['nome_contato', 'Nome do contato'], ['telefone', 'Telefone'], ['email', 'E-mail'], ['observacao', 'Observação'],
] as const;

export type ChaveClientes = (typeof COLUNAS_CLIENTES)[number][0];
export type ChaveEnderecos = (typeof COLUNAS_ENDERECOS)[number][0];
export type ChaveContatos = (typeof COLUNAS_CONTATOS)[number][0];
export type LinhaClientes = Partial<Record<ChaveClientes, string>>;
export type LinhaEnderecos = Partial<Record<ChaveEnderecos, string>>;
export type LinhaContatos = Partial<Record<ChaveContatos, string>>;
export type EntradaC<T> = { linha: number; v: T };

type ChaveTodas = ChaveClientes | ChaveEnderecos | ChaveContatos;
const POR_NOME = new Map<string, ChaveTodas>([
  ...COLUNAS_CLIENTES, ...COLUNAS_ENDERECOS, ...COLUNAS_CONTATOS,
].flatMap(([c, l]) => [[norm(c), c], [norm(l), c]] as [string, ChaveTodas][]));
const ALIAS: Record<string, ChaveTodas> = {
  tipo: 'tipo_pessoa', pessoa: 'tipo_pessoa', listapreco: 'tipo_lista_preco', nomecliente: 'nome', documento: 'cpf_cnpj',
  cpf: 'cpf_cnpj', cnpj: 'cpf_cnpj', datanascimento: 'aniversario', nascimento: 'aniversario', limite: 'limite_credito',
  mailnfe: 'email_destinatario_nfe', enderecoext: 'endereco_exterior', nomecontato: 'nome_contato', contato: 'nome_contato',
};
export const mapHeaderCliente = (h: string): ChaveTodas | null => POR_NOME.get(norm(h)) ?? ALIAS[norm(h)] ?? null;

export const parseDataBr = (v?: string): Date | null | undefined => {
  const s = v?.trim();
  if (!s) return undefined;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  const d = new Date(Number(aaaa), Number(mm) - 1, Number(dd));
  return d.getMonth() === Number(mm) - 1 && d.getDate() === Number(dd) ? d : null;
};
const parseEmail = (v?: string): string | null | undefined => {
  const s = v?.trim();
  if (!s) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null;
};
const parseFone = (v?: string): string | null | undefined => {
  const d = soDigitos(v ?? '');
  if (!v?.trim()) return undefined;
  return d.length >= 10 && d.length <= 11 ? d : null; // padrão brasileiro com DDD
};
const parseTipoPessoa = (v?: string): 'FISICA' | 'JURIDICA' | null | undefined => {
  const n = norm(v ?? '');
  if (!n) return undefined;
  return ['fisica', 'f', 'pf'].includes(n) ? 'FISICA' : ['juridica', 'j', 'pj'].includes(n) ? 'JURIDICA' : null;
};
const parseListaPreco = (v?: string): 'PADRAO' | 'BLOQUEADO' | null | undefined => {
  const n = norm(v ?? '');
  if (!n) return undefined;
  return n === 'padrao' ? 'PADRAO' : ['bloqueado', 'bloqueada'].includes(n) ? 'BLOQUEADO' : null;
};
const parseSexo = (v?: string): 'M' | 'F' | null | undefined => {
  const n = norm(v ?? '');
  if (!n || n === 'selecione') return undefined;
  return ['m', 'masculino'].includes(n) ? 'M' : ['f', 'feminino'].includes(n) ? 'F' : null;
};
export const parseCep = (v?: string): string | null | undefined => {
  const d = soDigitos(v ?? '');
  if (!v?.trim()) return undefined;
  return d.length === 8 ? d : null;
};

export type DadosCliente = {
  aba: 'clientes'; documento: string; tipoPessoa?: 'FISICA' | 'JURIDICA'; listaPreco?: 'PADRAO' | 'BLOQUEADO'; nome?: string; apelido?: string;
  rg?: string; emissor?: string; ufEmissor?: string; sexo?: 'M' | 'F'; aniversario?: Date; telefone?: string; celular?: string;
  email?: string; site?: string; observacao?: string; limiteCredito?: number; emailNfe?: string;
  issRetido?: boolean; consumidorFinal?: boolean; produtorRural?: boolean;
};
export type DadosEndereco = { aba: 'enderecos'; documento: string; cep?: string; endereco?: string; numero?: string; complemento?: string; bairro?: string; cidade?: string; uf?: string; exterior?: boolean; principal?: boolean };
export type DadosContato = { aba: 'contatos'; documento: string; nome?: string; telefone?: string; email?: string; observacao?: string };
export type ResultadoImportacao = {
  clientes: { linha: number; status: 'OK' | 'AVISO' | 'ERRO'; mensagens: string[]; dados?: DadosCliente; existente?: boolean }[];
  enderecos: { linha: number; status: 'OK' | 'AVISO' | 'ERRO'; mensagens: string[]; dados?: DadosEndereco }[];
  contatos: { linha: number; status: 'OK' | 'AVISO' | 'ERRO'; mensagens: string[]; dados?: DadosContato }[];
};

const txt = (s?: string) => s?.trim() || undefined;

/** Valida as três abas da planilha de clientes. `docsDb`: documentos normalizados já cadastrados (chave em minúsculas). */
export function validarClientes(
  planilha: { clientes: EntradaC<LinhaClientes>[]; enderecos: EntradaC<LinhaEnderecos>[]; contatos: EntradaC<LinhaContatos>[] },
  docsDb: Set<string>,
): ResultadoImportacao {
  const docsPlanilha = new Map<string, number>(); // documento normalizado → primeira linha
  const docsInvalidos = new Set<string>();

  const clientes = planilha.clientes.map(({ linha, v }: EntradaC<LinhaClientes>) => {
    const erros: string[] = [], avisos: string[] = [], infos: string[] = [];
    const bruto = txt(v.cpf_cnpj) ?? '';
    const documento = normalizarDocumento(bruto);
    const dados: DadosCliente = { aba: 'clientes', documento: documento ?? bruto };

    if (!txt(v.nome)) erros.push('Nome obrigatório.');
    if (!bruto) erros.push('CPF/CNPJ obrigatório.');
    else if (!documento) { erros.push('CPF/CNPJ inválido (dígitos verificadores não conferem).'); docsInvalidos.add(norm(bruto)); }

    if (documento) {
      const primeira = docsPlanilha.get(documento);
      if (primeira && primeira !== linha) erros.push(`CPF/CNPJ repetido na planilha (já aparece na linha ${primeira}).`);
      else docsPlanilha.set(documento, linha);
    }
    const existente = documento ? docsDb.has(documento) : false;
    if (existente) infos.push('Cliente já cadastrado: será atualizado ou ignorado, conforme o modo escolhido.');

    const tipoPessoa = parseTipoPessoa(v.tipo_pessoa);
    if (tipoPessoa === null) erros.push('Tipo de pessoa inválido (use "Física" ou "Jurídica").');
    const listaPreco = parseListaPreco(v.tipo_lista_preco);
    if (listaPreco === null) erros.push('Lista de preços inválida (use "Padrão" ou "Bloqueado").');
    const sexo = parseSexo(v.sexo);
    if (sexo === null) erros.push('Sexo inválido (use "Masculino" ou "Feminino").');
    const aniversario = parseDataBr(v.aniversario);
    if (aniversario === null) erros.push('Aniversário inválido (use dd/mm/aaaa).');
    const email = parseEmail(v.email);
    if (email === null) erros.push('E-mail inválido.');
    const emailNfe = parseEmail(v.email_destinatario_nfe);
    if (emailNfe === null) erros.push('E-mail do destinatário da NFe inválido.');
    const telefone = parseFone(v.telefone);
    if (telefone === null) erros.push('Telefone inválido (use DDD + número, ex.: (11) 98765-4321).');
    const celular = parseFone(v.celular);
    if (celular === null) erros.push('Celular inválido (use DDD + número).');
    const limite = parseMoney(v.limite_credito);
    if (limite === null) erros.push('Limite de crédito inválido.');
    const issRetido = parseSimNao(v.iss_retido_fonte);
    const consumidorFinal = parseSimNao(v.consumidor_final);
    const produtorRural = parseSimNao(v.produtor_rural);
    for (const [val, nome] of [[issRetido, 'ISS retido'], [consumidorFinal, 'Consumidor final'], [produtorRural, 'Produtor rural']] as const)
      if (val === null) erros.push(`${nome}: use "Sim" ou "Não".`);
    const ufEmissor = txt(v.uf_emissor);
    if (ufEmissor && !validarUf(ufEmissor)) erros.push('UF emissor inválida.');
    const temLimite = limite !== undefined && limite !== null;
    if (temLimite && limite! < 0) erros.push('Limite de crédito não pode ser negativo.');

    Object.assign(dados, {
      tipoPessoa: tipoPessoa ?? undefined, listaPreco: listaPreco ?? undefined, nome: txt(v.nome), apelido: txt(v.apelido),
      rg: txt(v.rg), emissor: txt(v.emissor), ufEmissor: ufEmissor?.toUpperCase(), sexo: sexo ?? undefined, aniversario: aniversario ?? undefined,
      telefone: telefone ?? undefined, celular: celular ?? undefined, email: email ?? undefined, site: txt(v.site), observacao: txt(v.observacao),
      limiteCredito: (limite ?? undefined) as number | undefined, emailNfe: emailNfe ?? undefined,
      issRetido: issRetido ?? undefined, consumidorFinal: consumidorFinal ?? undefined, produtorRural: produtorRural ?? undefined,
    });
    const status = (erros.length ? 'ERRO' : avisos.length ? 'AVISO' : 'OK') as 'OK' | 'AVISO' | 'ERRO';
    return { linha, status, mensagens: [...erros, ...avisos, ...infos], dados: erros.length ? undefined : dados, existente };
  });

  const docConhecido = (bruto: string) => {
    const n = normalizarDocumento(bruto);
    return (n && (docsPlanilha.has(n) || docsDb.has(n))) || docsInvalidos.has(norm(bruto)) ? n ?? norm(bruto) : null;
  };

  const enderecos = planilha.enderecos.map(({ linha, v }: EntradaC<LinhaEnderecos>) => {
    const erros: string[] = [], avisos: string[] = [];
    const bruto = txt(v.cpf_cnpj) ?? '';
    const doc = docConhecido(bruto);
    if (!bruto) erros.push('CPF/CNPJ de referência em branco.');
    else if (!doc) erros.push(`Cliente "${mascararDocumento(soDigitos(bruto))}" não existe na planilha nem no cadastro.`);
    const exterior = parseSimNao(v.endereco_exterior);
    const principal = parseSimNao(v.principal);
    if (exterior === null) erros.push('Endereço no exterior: use "Sim" ou "Não".');
    if (principal === null) erros.push('Principal: use "Sim" ou "Não".');
    const cep = parseCep(v.cep);
    if (cep === null) erros.push('CEP inválido (8 dígitos).');
    const uf = txt(v.uf);
    if (uf && !validarUf(uf)) erros.push('UF inválida.');
    if (exterior !== true) {
      if (!txt(v.endereco)) erros.push('Endereço obrigatório.');
      if (cep === undefined) avisos.push('Sem CEP: o endereço não será confirmado automaticamente.');
    } else if (cep !== undefined && cep !== null) avisos.push('Endereço no exterior não usa CEP (valor será ignorado).');
    const dados: DadosEndereco = {
      aba: 'enderecos', documento: doc ?? bruto, cep: exterior === true ? undefined : cep ?? undefined, endereco: txt(v.endereco), numero: txt(v.numero),
      complemento: txt(v.complemento), bairro: txt(v.bairro), cidade: txt(v.cidade), uf: uf?.toUpperCase(),
      exterior: exterior ?? undefined, principal: principal ?? undefined,
    };
    const status = (erros.length ? 'ERRO' : avisos.length ? 'AVISO' : 'OK') as 'OK' | 'AVISO' | 'ERRO';
    return { linha, status, mensagens: [...erros, ...avisos], dados: erros.length ? undefined : dados };
  });

  const contatos = planilha.contatos.map(({ linha, v }: EntradaC<LinhaContatos>) => {
    const erros: string[] = [];
    const bruto = txt(v.cpf_cnpj) ?? '';
    const doc = docConhecido(bruto);
    if (!bruto) erros.push('CPF/CNPJ de referência em branco.');
    else if (!doc) erros.push(`Cliente "${mascararDocumento(soDigitos(bruto))}" não existe na planilha nem no cadastro.`);
    if (!txt(v.nome_contato)) erros.push('Nome do contato obrigatório.');
    const email = parseEmail(v.email);
    if (email === null) erros.push('E-mail inválido.');
    const telefone = parseFone(v.telefone);
    if (telefone === null) erros.push('Telefone inválido (use DDD + número).');
    const dados: DadosContato = { aba: 'contatos', documento: doc ?? bruto, nome: txt(v.nome_contato), telefone: telefone ?? undefined, email: email ?? undefined, observacao: txt(v.observacao) };
    return { linha, status: erros.length ? 'ERRO' as const : 'OK' as const, mensagens: erros, dados: erros.length ? undefined : dados };
  });

  return { clientes, enderecos, contatos };
}
