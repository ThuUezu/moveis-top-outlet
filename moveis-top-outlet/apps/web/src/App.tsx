import { useState, type FormEvent } from 'react';
import { api, type Session } from './api';
import { Clientes } from './pages/Clientes';

const input = 'w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-700/30';
const button = 'w-full rounded-md bg-amber-800 px-4 py-2.5 font-medium text-white hover:bg-amber-900 focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 disabled:opacity-60';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [setup, setSetup] = useState<{ secret: string } | null>(null);
  const [pagina, setPagina] = useState<'clientes'>('clientes');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e: any) { if (e.codigo === '2FA_REQUERIDO') setNeedTotp(true); setError(e.message); } finally { setBusy(false); }
  }

  const login = (e: FormEvent) => { e.preventDefault(); run(async () => {
    setSession(await api<Session>('/auth/login', { body: { email, password, ...(needTotp ? { totp } : {}) } }));
  }); };

  const startSetup = () => run(async () => setSetup(await api('/auth/2fa/setup', { body: {}, token: session!.access })));
  const enable = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const t = await api<Pick<Session, 'access' | 'refresh' | 'scope'>>('/auth/2fa/enable', { body: { code: totp }, token: session!.access });
    setSession({ ...session!, ...t }); setSetup(null); setTotp('');
  }); };
  const logout = () => { if (session) api('/auth/logout', { body: { refresh: session.refresh } }).catch(() => {}); setSession(null); setPassword(''); setTotp(''); setNeedTotp(false); };

  return (
    <main className={`mx-auto flex min-h-screen flex-col gap-6 px-5 py-6 ${session?.scope === 'full' ? 'w-full max-w-5xl' : 'max-w-sm justify-center'}`}>
      <h1 className="text-2xl font-semibold">Móveis Top Outlet</h1>
      {!session && (
        <form onSubmit={login} className="flex flex-col gap-3">
          <label className="text-sm font-medium">E-mail<input className={input} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label className="text-sm font-medium">Senha<input className={input} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {needTotp && <label className="text-sm font-medium">Código do autenticador<input className={input} inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} required /></label>}
          <button className={button} disabled={busy}>Entrar</button>
        </form>
      )}
      {session?.scope === 'setup2fa' && (
        <div className="flex flex-col gap-3">
          <p>Para proteger o acesso de administrador, ative a verificação em duas etapas.</p>
          {!setup ? <button className={button} onClick={startSetup} disabled={busy}>Gerar chave do autenticador</button> : (
            <form onSubmit={enable} className="flex flex-col gap-3">
              <p className="text-sm">No aplicativo autenticador, adicione uma conta manualmente com esta chave:</p>
              <code className="break-all rounded-md bg-stone-200 px-3 py-2 text-sm">{setup.secret}</code>
              <label className="text-sm font-medium">Código de 6 dígitos<input className={input} inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} required /></label>
              <button className={button} disabled={busy}>Ativar 2FA</button>
            </form>
          )}
        </div>
      )}
      {session?.scope === 'full' && (
        <div className="flex w-full max-w-5xl flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">Móveis Top Outlet</h1>
            <nav className="flex gap-2 text-sm">
              <button className="rounded-md bg-stone-200 px-3 py-1.5 font-medium" onClick={() => setPagina('clientes')}>Clientes</button>
            <button className="rounded-md px-3 py-1.5 text-stone-500" disabled title="Etapa 5">Compras (etapa 5)</button>
              <button className="rounded-md px-3 py-1.5 text-stone-500" disabled title="Etapa 6">Vendas (etapa 6)</button>
            </nav>
            <p className="ml-auto text-sm text-stone-600">{session.user.name} · {session.user.role === 'ADMIN' ? 'Admin Master' : 'usuário'}</p>
            <button className="text-sm underline" onClick={logout}>Sair</button>
          </div>
          {pagina === 'clientes' && <Clientes token={session.access} isAdmin={session.user.role === 'ADMIN'} />}
        </div>
      )}
      {session?.scope === 'setup2fa' && <button className="text-sm underline" onClick={logout}>Sair</button>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </main>
  );
}
