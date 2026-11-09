import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, download, upload } from '../api';

const input = 'w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-base outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-700/30';
const label = 'block text-sm font-medium text-stone-700';
const btn = 'rounded-md bg-amber-800 px-4 py-2 font-medium text-white hover:bg-amber-900 disabled:opacity-60';
const btnSec = 'rounded-md border border-stone-300 bg-white px-4 py-2 font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-60';

const brl = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

function Campo({ titulo, children }: { titulo: string; children: ReactNode }) {
  return <label className={label}>{titulo}{children}</label>;
}

type ClienteResumido = { id: string; nome: string; apelido: string | null; documento: string; tipoDocumento: string; telefone: string | null; celular: string | null; email: string | null; listaPreco: string; arquivado: boolean };
type Opcoes = { modo: 'SOMENTE_CRIAR' | 'CRIAR_E_ATUALIZAR' | 'REVISAR'; confirmarAvisos: boolean; decisoes?: { linha: number; decisao: 'CRIAR' | 'ATUALIZAR' | 'IGNORAR' }[] };

// ---------- Assistente de importação ----------
function ImportarClientes({ token, aoConcluir }: { token: string; aoConcluir: () => void }) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [opcoes, setOpcoes] = useState<Opcoes>({ modo: 'CRIAR_E_ATUALIZAR', confirmarAvisos: true });
  const [progresso, setProgresso] = useState<string | null>(null);
  const [erro, setErro] = useState('');
  const [decisoes, setDecisoes] = useState<Record<number, string>>({});

  const enviar = async () => {
    if (!arquivo) return;
    setErro('');
    try {
      setPreview(await upload('/imports/customers/preview', arquivo, token));
    } catch (e: any) { setErro(e.message); }
  };

  const confirmar = async () => {
    if (!preview) return;
    setErro(''); setProgresso('Importando…');
    try {
      await api(`/imports/${preview.importId}/confirm`, {
        body: {
          modo: opcoes.modo, confirmarAvisos: opcoes.confirmarAvisos,
          ...(opcoes.modo === 'REVISAR' ? { decisoes: Object.entries(decisoes).map(([linha, d]) => ({ linha: Number(linha), decisao: d })) } : {}),
        }, token,
      });
      aoConcluir();
    } catch (e: any) { setErro(e.message); } finally { setProgresso(null); }
  };

  const t = preview?.totais;
  const problemas = preview ? [...(preview.linhasComProblema.clientes ?? []), ...(preview.linhasComProblema.enderecos ?? []), ...(preview.linhasComProblema.contatos ?? [])] : [];
  const revisaveis: number[] = preview?.mudancas?.length ? [...new Set<number>(preview.mudancas.map((m: any) => m.linha as number))] : [];

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
      <h3 className="font-semibold">Importar clientes (.xlsx com 3 abas)</h3>
      <div className="flex flex-wrap items-center gap-2">
        <button className={btnSec} onClick={() => download('/imports/customers/template', token, 'modelo_clientes.xlsx')}>Baixar modelo de clientes</button>
        <input type="file" accept=".xlsx" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} className="text-sm" />
        <button className={btn} onClick={enviar} disabled={!arquivo}>Pré-visualizar</button>
      </div>
      {preview && t && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2 text-center text-sm sm:grid-cols-9">
            {(['clientes', 'enderecos', 'contatos'] as const).map((aba) => (
              <div key={aba} className="col-span-1 rounded bg-white p-2 sm:col-span-3">
                <p className="font-semibold capitalize">{aba}</p>
                <p>{t[aba].ok} OK · {t[aba].avisos} avisos · {t[aba].erros} erros</p>
              </div>
            ))}
          </div>
          {problemas.length > 0 && (
            <details className="rounded bg-white p-3 text-sm">
              <summary className="cursor-pointer font-medium">Linhas com aviso ou erro ({problemas.length})</summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
                {problemas.map((p: any, i: number) => <li key={i}><b>Linha {p.linha}</b> ({p.status}): {p.mensagens.join(' ')}</li>)}
              </ul>
            </details>
          )}
          {preview.mudancas?.length > 0 && opcoes.modo === 'REVISAR' && (
            <details className="rounded bg-white p-3 text-sm" open>
              <summary className="cursor-pointer font-medium">Revisar um a um: {revisaveis.length} cliente(s) com alteração</summary>
              <div className="mt-2 max-h-56 space-y-2 overflow-auto">
                {revisaveis.map((linha: number) => (
                  <div key={linha} className="rounded border border-stone-200 p-2">
                    <div className="flex items-center justify-between">
                      <b>Linha {linha}</b>
                      <select className={input + ' !w-auto'} value={decisoes[linha] ?? 'ATUALIZAR'} onChange={(e) => setDecisoes({ ...decisoes, [linha]: e.target.value })}>
                        <option value="ATUALIZAR">Atualizar</option><option value="IGNORAR">Ignorar</option>
                      </select>
                    </div>
                    <ul className="mt-1 text-xs text-stone-600">
                      {preview.mudancas.filter((m: any) => m.linha === linha).map((m: any, i: number) => <li key={i}>{m.campo}: {String(m.atual)} → {String(m.novo)}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm">Modo:
              <select className={input + ' ml-2 !w-auto'} value={opcoes.modo} onChange={(e) => setOpcoes({ ...opcoes, modo: e.target.value as Opcoes['modo'] })}>
                <option value="SOMENTE_CRIAR">Somente criar novos</option>
                <option value="CRIAR_E_ATUALIZAR">Criar e atualizar</option>
                <option value="REVISAR">Revisar um a um</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={opcoes.confirmarAvisos} onChange={(e) => setOpcoes({ ...opcoes, confirmarAvisos: e.target.checked })} />Importar linhas com aviso</label>
            <button className={btn} onClick={confirmar} disabled={!!progresso || t.clientes.ok + t.clientes.avisos === 0}>{progresso ?? 'Confirmar importação'}</button>
            <button className={btnSec} onClick={() => download(`/imports/${preview.importId}/report`, token, 'linhas_rejeitadas_clientes.xlsx')}>Baixar linhas rejeitadas</button>
          </div>
        </div>
      )}
      {erro && <p role="alert" className="text-sm text-red-700">{erro}</p>}
    </div>
  );
}

// ---------- Formulário de dados principais ----------
const VAZIO = { personType: 'FISICA', priceList: 'PADRAO', name: '', nickname: '', document: '', rg: '', rgIssuer: '', rgUf: '', gender: '', birthDate: '', phone: '', mobile: '', email: '', website: '', notes: '', creditLimit: '', nfeEmail: '', issWithheld: false, consumerFinal: false, ruralProducer: false };

function FormCliente({ token, inicial, aoSalvar, aoCancelar }: { token: string; inicial?: any; aoSalvar: () => void; aoCancelar: () => void }) {
  const [f, setF] = useState<any>({ ...VAZIO, ...(inicial ? { ...inicial, birthDate: inicial.birthDate ? inicial.birthDate.slice(0, 10) : '', creditLimit: inicial.creditLimit ?? '' } : {}) });
  const [erro, setErro] = useState('');
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });

  const salvar = async (e: FormEvent) => {
    e.preventDefault();
    setErro('');
    const body = {
      ...f, nickname: f.nickname || null, rg: f.rg || null, rgIssuer: f.rgIssuer || null, rgUf: f.rgUf || null,
      gender: f.gender || null, birthDate: f.birthDate ? new Date(f.birthDate + 'T12:00:00') : null,
      phone: f.phone || null, mobile: f.mobile || null, email: f.email || null, website: f.website || null, notes: f.notes || null,
      creditLimit: f.creditLimit === '' ? null : Number(f.creditLimit), nfeEmail: f.nfeEmail || null,
    };
    try {
      if (inicial?.id) await api(`/customers/${inicial.id}`, { method: 'PATCH', body, token });
      else await api('/customers', { body, token });
      aoSalvar();
    } catch (e: any) { setErro(e.message); }
  };

  return (
    <form onSubmit={salvar} className="flex flex-col gap-3 rounded-lg border border-stone-200 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Campo titulo="Tipo de pessoa"><select className={input} value={f.personType} onChange={(e) => set('personType', e.target.value)}><option value="FISICA">Física</option><option value="JURIDICA">Jurídica</option></select></Campo>
        <Campo titulo="Lista de preços"><select className={input} value={f.priceList} onChange={(e) => set('priceList', e.target.value)}><option value="PADRAO">Padrão</option><option value="BLOQUEADO">Bloqueado</option></select></Campo>
        <Campo titulo="Nome *"><input className={input} value={f.name} onChange={(e) => set('name', e.target.value)} required /></Campo>
        <Campo titulo="Apelido"><input className={input} value={f.nickname} onChange={(e) => set('nickname', e.target.value)} /></Campo>
        <Campo titulo="CPF/CNPJ *"><input className={input} value={f.document} onChange={(e) => set('document', e.target.value)} required placeholder="000.000.000-00" /></Campo>
        <Campo titulo="RG"><input className={input} value={f.rg} onChange={(e) => set('rg', e.target.value)} /></Campo>
        <Campo titulo="Emissor"><input className={input} value={f.rgIssuer} onChange={(e) => set('rgIssuer', e.target.value)} /></Campo>
        <Campo titulo="UF emissor"><input className={input} maxLength={2} value={f.rgUf} onChange={(e) => set('rgUf', e.target.value.toUpperCase())} /></Campo>
        <Campo titulo="Sexo"><select className={input} value={f.gender} onChange={(e) => set('gender', e.target.value)}><option value="">Selecione</option><option value="F">Feminino</option><option value="M">Masculino</option></select></Campo>
        <Campo titulo="Aniversário"><input className={input} type="date" value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></Campo>
        <Campo titulo="Telefone"><input className={input} value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="(11) 3456-7890" /></Campo>
        <Campo titulo="Celular"><input className={input} value={f.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="(11) 98765-4321" /></Campo>
        <Campo titulo="E-mail"><input className={input} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Campo>
        <Campo titulo="Site"><input className={input} value={f.website} onChange={(e) => set('website', e.target.value)} /></Campo>
        <Campo titulo="Limite de crédito (R$)"><input className={input} inputMode="decimal" value={f.creditLimit} onChange={(e) => set('creditLimit', e.target.value)} placeholder="0,00" /></Campo>
        <Campo titulo="E-mail NFe"><input className={input} type="email" value={f.nfeEmail} onChange={(e) => set('nfeEmail', e.target.value)} /></Campo>
      </div>
      <fieldset className="grid grid-cols-3 gap-2 rounded border border-stone-200 p-3 text-sm">
        <legend className="px-1">Dados fiscais</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.issWithheld} onChange={(e) => set('issWithheld', e.target.checked)} />ISS retido na fonte</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.consumerFinal} onChange={(e) => set('consumerFinal', e.target.checked)} />Consumidor final</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.ruralProducer} onChange={(e) => set('ruralProducer', e.target.checked)} />Produtor rural</label>
      </fieldset>
      <Campo titulo="Observação"><textarea className={input} rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Campo>
      <div className="flex gap-2">
        <button className={btn} type="submit">Salvar cliente</button>
        <button className={btnSec} type="button" onClick={aoCancelar}>Cancelar</button>
      </div>
      {erro && <p role="alert" className="text-sm text-red-700">{erro}</p>}
    </form>
  );
}

// ---------- Ficha do cliente (abas) ----------
const ABAS_FICHA = [
  ['enderecos', 'Endereços'], ['contatos', 'Contatos'], ['banco', 'Dados bancários'],
  ['documentos', 'Documentos'], ['credito', 'Crédito'], ['historico', 'Histórico'],
] as const;

function Ficha({ token, cliente, isAdmin, aoVoltar, aoAtualizar }: { token: string; cliente: any; isAdmin: boolean; aoVoltar: () => void; aoAtualizar: () => void }) {
  const [aba, setAba] = useState<(typeof ABAS_FICHA)[number][0]>('enderecos');
  const [dados, setDados] = useState<any>(null);
  const [credit, setCredit] = useState<any>(null);
  const [historico, setHistorico] = useState<any>({ vendas: [] });
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    const [ficha, cred, hist] = await Promise.all([
      api<any>(`/customers/${cliente.id}`, { token }), api<any>(`/customers/${cliente.id}/credit`, { token }), api<any>(`/customers/${cliente.id}/history`, { token }),
    ]);
    setDados(ficha); setCredit(cred); setHistorico(hist);
  }, [cliente.id, token]);
  useEffect(() => { carregar().catch((e) => setErro(e.message)); }, [carregar]);

  const excluir = async () => {
    if (!confirm('Excluir este cliente?')) return;
    try {
      const r = await api(`/customers/${cliente.id}`, { method: 'DELETE', token }) as any;
      alert(r.mensagem ?? 'Cliente excluído.');
      aoVoltar();
    } catch (e: any) { setErro(e.message); }
  };

  if (!dados) return <p className="text-sm text-stone-500">Carregando… {erro}</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">{dados.name}</h3>
          <p className="text-sm text-stone-600">{dados.document} · {dados.personType === 'FISICA' ? 'Pessoa física' : 'Pessoa jurídica'} · Lista {dados.priceList === 'PADRAO' ? 'padrão' : 'bloqueada'}</p>
        </div>
        <div className="flex gap-2">
          <button className={btnSec} onClick={() => download(`/customers/${dados.id}/export`, token, `cliente_${dados.document.replace(/\D/g, '')}.json`)}>Exportar dados (LGPD)</button>
          <button className="rounded-md bg-red-800 px-4 py-2 font-medium text-white hover:bg-red-900" onClick={excluir}>{isAdmin ? 'Excluir / arquivar' : 'Arquivar'}</button>
        </div>
      </div>
      <nav className="flex flex-wrap gap-1 overflow-x-auto">
        {ABAS_FICHA.map(([id, nome]) => (
          <button key={id} onClick={() => setAba(id)} className={`rounded-t-md px-3 py-2 text-sm font-medium ${aba === id ? 'bg-amber-800 text-white' : 'bg-stone-200 text-stone-700 hover:bg-stone-300'}`}>{nome}</button>
        ))}
      </nav>
      {aba === 'enderecos' && <AbaEnderecos token={token} dados={dados} aoMudar={carregar} />}
      {aba === 'contatos' && <AbaContatos token={token} dados={dados} aoMudar={carregar} />}
      {aba === 'banco' && <AbaBanco token={token} dados={dados} aoMudar={carregar} />}
      {aba === 'documentos' && <AbaDocumentos token={token} dados={dados} aoMudar={carregar} />}
      {aba === 'credito' && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-stone-100 p-3"><p className="text-xs text-stone-500">Limite</p><p className="font-semibold">{brl(dados.creditLimit)}</p></div>
          <div className="rounded bg-stone-100 p-3"><p className="text-xs text-stone-500">Utilizado</p><p className="font-semibold">{brl(credit?.utilizado)}</p></div>
          <div className="rounded bg-stone-100 p-3"><p className="text-xs text-stone-500">Disponível</p><p className="font-semibold">{brl(credit?.disponivel)}</p></div>
        </div>
      )}
      {aba === 'historico' && (
        <div className="rounded-lg border border-stone-200 p-3 text-sm">
          {historico?.vendas?.length ? (
            <ul className="space-y-1">
              {historico.vendas.map((v: any) => <li key={v.id}>{new Date(v.data).toLocaleDateString('pt-BR')} — {v.produto} (SKU {v.sku}) × {v.quantidade} · {brl(v.total)}</li>)}
            </ul>
          ) : <p className="text-stone-500">Nenhuma compra registrada ainda. O histórico passa a ser preenchido na Etapa 6 (Vendas).</p>}
          <FiltroCampanha token={token} />
        </div>
      )}
      {erro && <p role="alert" className="text-sm text-red-700">{erro}</p>}
    </div>
  );
}

function FiltroCampanha({ token }: { token: string }) {
  const [produtoId, setProdutoId] = useState('');
  const [qtd, setQtd] = useState('1');
  const [items, setItems] = useState<any[] | null>(null);
  const buscar = async () => {
    if (!produtoId) return;
    const r = await api<{ items: any[] }>(`/customers/filters/purchased?produtoId=${encodeURIComponent(produtoId)}&minQuantidade=${qtd || 1}`, { token });
    setItems(r.items);
  };
  return (
    <div className="mt-3 rounded bg-stone-50 p-3">
      <p className="mb-2 text-sm font-medium">Campanha: clientes que compraram um produto</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className={input + ' !w-56'} placeholder="ID do produto" value={produtoId} onChange={(e) => setProdutoId(e.target.value)} />
        <input className={input + ' !w-24'} inputMode="numeric" placeholder="Mín. unid." value={qtd} onChange={(e) => setQtd(e.target.value)} />
        <button className={btnSec} onClick={buscar}>Filtrar</button>
      </div>
      {items && <p className="mt-2 text-sm">{items.length ? `${items.length} cliente(s) encontrado(s): ${items.map((i) => i.nome).join(', ')}` : 'Nenhum cliente encontrado.'}</p>}
    </div>
  );
}

function AbaEnderecos({ token, dados, aoMudar }: any) {
  const [f, setF] = useState<any>({ zipCode: '', street: '', number: '', complement: '', district: '', city: '', state: '', isForeign: false, isMain: false });
  const [erro, setErro] = useState('');
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });

  const buscarCep = async () => {
    const cep = f.zipCode.replace(/\D/g, '');
    if (cep.length !== 8) return;
    try {
      const r = await api<any>(`/cep/${cep}`, { token });
      setF((ant: any) => ({ ...ant, street: ant.street || r.endereco, district: ant.district || r.bairro, city: ant.city || r.cidade, state: ant.state || r.uf }));
    } catch { /* CEP não encontrado: segue manual */ }
  };
  const salvar = async (e: FormEvent) => {
    e.preventDefault(); setErro('');
    try {
      await api(`/customers/${dados.id}/addresses`, { body: f, token });
      setF({ zipCode: '', street: '', number: '', complement: '', district: '', city: '', state: '', isForeign: false, isMain: false });
      aoMudar();
    } catch (e: any) { setErro(e.message); }
  };
  const remover = async (id: string) => { await api(`/customers/${dados.id}/addresses/${id}`, { method: 'DELETE', token }); aoMudar(); };

  return (
    <div className="flex flex-col gap-3">
      {!dados.addresses.length && <p className="rounded bg-stone-100 p-3 text-sm text-stone-500">Nenhum endereço informado</p>}
      {dados.addresses.map((a: any) => (
        <div key={a.id} className="flex items-start justify-between rounded-lg border border-stone-200 p-3 text-sm">
          <p>{a.isForeign ? a.street : <>{a.street}{a.number ? `, ${a.number}` : ''}{a.complement ? ` — ${a.complement}` : ''}<br />{a.district ? `${a.district} · ` : ''}{a.city}{a.state ? `/${a.state}` : ''}{a.zipCode ? ` · CEP ${a.zipCode}` : ''}</>}{a.isMain ? ' · principal' : ''}</p>
          <button className="text-red-700 underline" onClick={() => remover(a.id)}>Remover</button>
        </div>
      ))}
      <form onSubmit={salvar} className="grid grid-cols-2 gap-2 rounded-lg bg-stone-50 p-3 sm:grid-cols-4">
        {!f.isForeign && <Campo titulo="CEP"><input className={input} value={f.zipCode} onChange={(e) => set('zipCode', e.target.value)} onBlur={buscarCep} placeholder="01310-100" /></Campo>}
        <Campo titulo={f.isForeign ? 'Endereço no exterior' : 'Endereço'}><input className={input} value={f.street} onChange={(e) => set('street', e.target.value)} required /></Campo>
        <Campo titulo="Número"><input className={input} value={f.number} onChange={(e) => set('number', e.target.value)} /></Campo>
        <Campo titulo="Complemento"><input className={input} value={f.complement} onChange={(e) => set('complement', e.target.value)} /></Campo>
        {!f.isForeign && <>
          <Campo titulo="Bairro"><input className={input} value={f.district} onChange={(e) => set('district', e.target.value)} /></Campo>
          <Campo titulo="Cidade"><input className={input} value={f.city} onChange={(e) => set('city', e.target.value)} /></Campo>
          <Campo titulo="UF"><input className={input} maxLength={2} value={f.state} onChange={(e) => set('state', e.target.value.toUpperCase())} /></Campo>
        </>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isForeign} onChange={(e) => set('isForeign', e.target.checked)} />Exterior</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isMain} onChange={(e) => set('isMain', e.target.checked)} />Principal</label>
        <div className="col-span-2 flex items-end"><button className={btn} type="submit">Adicionar endereço</button></div>
        {erro && <p className="col-span-full text-sm text-red-700">{erro}</p>}
      </form>
    </div>
  );
}

function AbaContatos({ token, dados, aoMudar }: any) {
  const [f, setF] = useState({ name: '', phone: '', email: '', notes: '' });
  const salvar = async (e: FormEvent) => {
    e.preventDefault();
    await api(`/customers/${dados.id}/contacts`, { body: f, token });
    setF({ name: '', phone: '', email: '', notes: '' });
    aoMudar();
  };
  return (
    <div className="flex flex-col gap-3">
      {!dados.contacts.length && <p className="rounded bg-stone-100 p-3 text-sm text-stone-500">Nenhum contato cadastrado</p>}
      {dados.contacts.map((c: any) => (
        <div key={c.id} className="flex items-center justify-between rounded-lg border border-stone-200 p-3 text-sm">
          <p><b>{c.name}</b>{c.phone ? ` · ${c.phone}` : ''}{c.email ? ` · ${c.email}` : ''}{c.notes ? ` — ${c.notes}` : ''}</p>
          <button className="text-red-700 underline" onClick={async () => { await api(`/customers/${dados.id}/contacts/${c.id}`, { method: 'DELETE', token }); aoMudar(); }}>Remover</button>
        </div>
      ))}
      <form onSubmit={salvar} className="grid grid-cols-2 gap-2 rounded-lg bg-stone-50 p-3 sm:grid-cols-4">
        <Campo titulo="Nome *"><input className={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Campo>
        <Campo titulo="Telefone"><input className={input} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Campo>
        <Campo titulo="E-mail"><input className={input} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
        <Campo titulo="Observação"><input className={input} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Campo>
        <div className="col-span-2 flex items-end"><button className={btn} type="submit">Adicionar contato</button></div>
      </form>
    </div>
  );
}

function AbaBanco({ token, dados, aoMudar }: any) {
  const [f, setF] = useState({ bankName: '', agency: '', account: '', accountType: '', pixKey: '', notes: '' });
  const [erro, setErro] = useState('');
  const salvar = async (e: FormEvent) => {
    e.preventDefault(); setErro('');
    try {
      await api(`/customers/${dados.id}/bank`, { body: f, token });
      setF({ bankName: '', agency: '', account: '', accountType: '', pixKey: '', notes: '' });
      aoMudar();
    } catch (e: any) { setErro(e.message); }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-stone-500">Dados bancários são sensíveis: todo acesso fica registrado no log de auditoria.</p>
      {!dados.bankData.length && <p className="rounded bg-stone-100 p-3 text-sm text-stone-500">Nenhum dado bancário cadastrado</p>}
      {dados.bankData.map((b: any) => (
        <div key={b.id} className="flex items-center justify-between rounded-lg border border-stone-200 p-3 text-sm">
          <p><b>{b.bankName}</b>{b.agency ? ` · Ag. ${b.agency}` : ''}{b.account ? ` · Conta ${b.account}` : ''}{b.pixKey ? ' · Chave PIX ***' : ''}</p>
          <button className="text-red-700 underline" onClick={async () => { await api(`/customers/${dados.id}/bank/${b.id}`, { method: 'DELETE', token }); aoMudar(); }}>Remover</button>
        </div>
      ))}
      <form onSubmit={salvar} className="grid grid-cols-2 gap-2 rounded-lg bg-stone-50 p-3 sm:grid-cols-3">
        <Campo titulo="Banco *"><input className={input} value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} required /></Campo>
        <Campo titulo="Agência"><input className={input} value={f.agency} onChange={(e) => setF({ ...f, agency: e.target.value })} /></Campo>
        <Campo titulo="Conta"><input className={input} value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} /></Campo>
        <Campo titulo="Tipo"><select className={input} value={f.accountType} onChange={(e) => setF({ ...f, accountType: e.target.value })}><option value="">—</option><option>Corrente</option><option>Poupança</option></select></Campo>
        <Campo titulo="Chave PIX"><input className={input} value={f.pixKey} onChange={(e) => setF({ ...f, pixKey: e.target.value })} /></Campo>
        <div className="flex items-end"><button className={btn} type="submit">Adicionar</button></div>
        {erro && <p className="col-span-full text-sm text-red-700">{erro}</p>}
      </form>
    </div>
  );
}

function AbaDocumentos({ token, dados, aoMudar }: any) {
  const [erro, setErro] = useState('');
  const enviar = async (file: File) => {
    setErro('');
    try { await upload(`/customers/${dados.id}/documents`, file, token); aoMudar(); }
    catch (e: any) { setErro(e.message); }
  };
  const abrir = async (docId: string) => {
    const r = await api(`/customers/${dados.id}/documents/${docId}/download`, { token }) as any;
    window.open(r.url, '_blank');
  };
  return (
    <div className="flex flex-col gap-3">
      {!dados.documents.length && <p className="rounded bg-stone-100 p-3 text-sm text-stone-500">Nenhum documento anexado</p>}
      {dados.documents.map((d: any) => (
        <div key={d.id} className="flex items-center justify-between rounded-lg border border-stone-200 p-3 text-sm">
          <p>{d.fileName} · {(d.size / 1024).toFixed(0)} KB · {new Date(d.createdAt).toLocaleDateString('pt-BR')}</p>
          <div className="flex gap-3">
            <button className="text-amber-800 underline" onClick={() => abrir(d.id)}>Abrir</button>
            <button className="text-red-700 underline" onClick={async () => { await api(`/customers/${dados.id}/documents/${d.id}`, { method: 'DELETE', token }); aoMudar(); }}>Remover</button>
          </div>
        </div>
      ))}
      <label className={btnSec + ' w-fit cursor-pointer'}>
        Anexar documento
        <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) enviar(f); e.target.value = ''; }} />
      </label>
      {erro && <p role="alert" className="text-sm text-red-700">{erro}</p>}
    </div>
  );
}

// ---------- Página principal ----------
export function Clientes({ token, isAdmin }: { token: string; isAdmin: boolean }) {
  const [busca, setBusca] = useState('');
  const [arquivados, setArquivados] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; items: ClienteResumido[] }>({ total: 0, items: [] });
  const [view, setView] = useState<'lista' | 'novo' | 'editar' | 'ficha' | 'importar'>('lista');
  const [selecionado, setSelecionado] = useState<ClienteResumido | null>(null);
  const [ficha, setFicha] = useState<any>(null);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    const r = await api<{ total: number; items: ClienteResumido[] }>(`/customers?busca=${encodeURIComponent(busca)}&arquivados=${arquivados}&page=${page}`, { token });
    setData(r);
  }, [busca, arquivados, page, token]);
  useEffect(() => { carregar().catch((e) => setErro(e.message)); }, [carregar]);

  const abrirFicha = async (c: ClienteResumido) => {
    setSelecionado(c); setView('ficha');
    try { setFicha(await api(`/customers/${c.id}`, { token })); } catch (e: any) { setErro(e.message); }
  };
  const editar = async (c: ClienteResumido) => {
    try { setFicha(await api(`/customers/${c.id}`, { token })); setSelecionado(c); setView('editar'); } catch (e: any) { setErro(e.message); }
  };

  const totalPaginas = Math.max(1, Math.ceil(data.total / 20));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className={input + ' !w-64'} placeholder="Buscar por nome, CPF/CNPJ ou telefone" value={busca} onChange={(e) => { setBusca(e.target.value); setPage(1); }} />
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={arquivados} onChange={(e) => { setArquivados(e.target.checked); setPage(1); }} />Mostrar arquivados</label>
        <div className="ml-auto flex gap-2">
          <button className={btnSec} onClick={() => download('/exports/customers', token, 'clientes.xlsx')}>Exportar</button>
          <button className={btnSec} onClick={() => setView('importar')}>Importar</button>
          <button className={btn} onClick={() => { setFicha(null); setView('novo'); }}>Novo cliente</button>
        </div>
      </div>

      {view === 'importar' && <ImportarClientes token={token} aoConcluir={() => { setView('lista'); carregar(); }} />}
      {view === 'novo' && <FormCliente token={token} aoSalvar={() => { setView('lista'); carregar(); }} aoCancelar={() => setView('lista')} />}
      {view === 'editar' && ficha && <FormCliente token={token} inicial={ficha} aoSalvar={() => { setView('lista'); carregar(); }} aoCancelar={() => setView('lista')} />}
      {view === 'ficha' && selecionado && (
        <Ficha token={token} cliente={selecionado} isAdmin={isAdmin} aoVoltar={() => { setView('lista'); carregar(); }} aoAtualizar={() => abrirFicha(selecionado)} />
      )}

      {view === 'lista' && (
        <>
          <p className="text-sm text-stone-600">{data.total} cliente(s) — CPF/CNPJ e telefones mascarados nas listagens (LGPD).</p>
          <div className="overflow-hidden rounded-lg border border-stone-200">
            <table className="hidden w-full text-sm sm:table">
              <thead className="bg-stone-100 text-left"><tr><th className="p-2">Nome</th><th className="p-2">CPF/CNPJ</th><th className="p-2">Telefone</th><th className="p-2">Lista</th><th className="p-2"></th></tr></thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="border-t border-stone-200">
                    <td className="p-2">{c.nome}{c.apelido ? ` (${c.apelido})` : ''}{c.arquivado ? ' · arquivado' : ''}</td>
                    <td className="p-2">{c.documento}</td>
                    <td className="p-2">{c.celular ?? c.telefone ?? '—'}</td>
                    <td className="p-2">{c.listaPreco === 'PADRAO' ? 'Padrão' : 'Bloqueada'}</td>
                    <td className="p-2 text-right"><button className="text-amber-800 underline" onClick={() => abrirFicha(c)}>Ficha</button>{' '}<button className="text-stone-500 underline" onClick={() => editar(c)}>Editar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-col sm:hidden">
              {data.items.map((c) => (
                <div key={c.id} className="border-b border-stone-200 p-3 text-sm">
                  <p className="font-medium">{c.nome}{c.arquivado ? ' · arquivado' : ''}</p>
                  <p className="text-stone-600">{c.documento} · {c.celular ?? c.telefone ?? '—'}</p>
                  <div className="mt-1 flex gap-3"><button className="text-amber-800 underline" onClick={() => abrirFicha(c)}>Ficha</button><button className="text-stone-500 underline" onClick={() => editar(c)}>Editar</button></div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button className={btnSec} disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>Página {page} de {totalPaginas}</span>
            <button className={btnSec} disabled={page >= totalPaginas} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        </>
      )}
      {erro && <p role="alert" className="text-sm text-red-700">{erro}</p>}
    </div>
  );
}
