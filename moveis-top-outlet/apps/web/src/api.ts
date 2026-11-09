const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';

export type Session = {
  access: string;
  refresh: string;
  scope: 'full' | 'setup2fa';
  user: { id: string; name: string; email: string; role: 'ADMIN' | 'USER' };
};

type Metodo = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function chamar<T>(path: string, init: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.erro ?? 'Algo deu errado. Tente novamente.'), { codigo: data.codigo as string | undefined, requerConfirmacao: data.requerConfirmacao as boolean | undefined });
  return data as T;
}

export async function api<T>(path: string, opts: { method?: Metodo; body?: unknown; token?: string } = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');
  return chamar<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  });
}

/** Upload multipart (arquivos de importação e documentos). */
export async function upload<T>(path: string, file: File, token: string): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return chamar<T>(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

/** Download autenticado (modelos, relatórios e exportações). */
export async function download(path: string, token: string, nome?: string) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.erro ?? 'Não foi possível baixar o arquivo.');
  }
  const blob = await r.blob();
  const disposition = r.headers.get('Content-Disposition') ?? '';
  const m = /filename="?([^";]+)"?/.exec(disposition);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome ?? m?.[1] ?? 'arquivo';
  a.click();
  URL.revokeObjectURL(a.href);
}
