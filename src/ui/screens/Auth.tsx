import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type AuthView = 'login' | 'signup' | 'reset' | 'recovery';
export function Auth({ client, onOpen, onBack, opening }: {
  client: SupabaseClient | null; onOpen: () => void; onBack: () => void; opening: boolean;
}) {
  const [view, setView] = useState<AuthView>(location.pathname === '/auth/recovery' ? 'recovery' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      setSignedIn(data.session !== null);
      if (sessionError) setError(sessionError.message);
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Session lookup failed.'); });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      // Keep this callback synchronous; further auth calls run only from user actions.
      setSignedIn(session !== null);
      if (event === 'PASSWORD_RECOVERY') setView('recovery');
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client]);

  async function submit() {
    if (!client || pending) return;
    setPending(true); setError(''); setMessage('');
    try {
      if (view === 'login') {
        const result = await client.auth.signInWithPassword({ email, password });
        if (result.error) setError(result.error.message);
        else { setSignedIn(result.data.session !== null); setPassword(''); setMessage('Signed in. Open your workspace when ready.'); }
      } else if (view === 'signup') {
        const result = await client.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/auth/callback` } });
        if (result.error) setError(result.error.message);
        else { setSignedIn(result.data.session !== null); setPassword(''); setMessage(result.data.session ? 'Account created. Open your workspace.' : 'Check your email to confirm your account, then return here.'); }
      } else if (view === 'reset') {
        const result = await client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/auth/recovery` });
        if (result.error) setError(result.error.message);
        else setMessage('If this address has an account, a recovery link will arrive by email.');
      } else {
        const result = await client.auth.updateUser({ password });
        if (result.error) setError(result.error.message);
        else { setPassword(''); setMessage('Password updated. You can open your workspace.'); setView('login'); history.replaceState({}, document.title, '/'); }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Authentication could not complete.'); }
    finally { setPending(false); }
  }
  return <main className="setup-page"><div className="setup-wordmark"><span className="brand-mark">κ</span> JUDGE CALIBRATION LAB</div><div className="setup-grid"><section><div className="eyebrow">YOUR PERSISTENT WORKSPACE</div><h1>{view === 'signup' ? 'Create an account.' : view === 'reset' ? 'Recover access.' : view === 'recovery' ? 'Set a new password.' : 'Welcome back.'}</h1><p>Private data stays in your account. Live calls require a saved judge, a price entry, a budget and an explicit run confirmation.</p><button type="button" onClick={onBack} disabled={pending || opening}>← Back to setup</button></section><section className="panel">
    {!client ? <div className="notice">Configure the public workspace connection before signing in. The offline demo remains available from setup.</div> : <>
      {error && <div role="alert" className="error-message">{error}</div>}{message && <div role="status" className="success-message">{message}</div>}
      {signedIn && view !== 'recovery' ? <><h2>Your session is ready.</h2><button type="button" className="primary" onClick={onOpen} disabled={opening || pending}>{opening ? 'Opening workspace…' : 'Open workspace'}</button><button type="button" className="text-button" disabled={pending || opening} onClick={() => { setPending(true); void client.auth.signOut().then(({ error: signoutError }) => { if (signoutError) setError(signoutError.message); else { setSignedIn(false); setMessage('Signed out.'); } }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Sign out failed.')).finally(() => setPending(false)); }}>Sign out</button></> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {view !== 'recovery' && <label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
        {view !== 'reset' && <label>{view === 'recovery' ? 'New password' : 'Password'}<input required type="password" autoComplete={view === 'login' ? 'current-password' : 'new-password'} minLength={view === 'login' ? undefined : 8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
        <button type="submit" className="primary" disabled={pending || opening}>{pending ? 'Please wait…' : view === 'login' ? 'Sign in' : view === 'signup' ? 'Create account' : view === 'reset' ? 'Send recovery link' : 'Update password'}</button>
        <div className="actions">{view !== 'login' && <button type="button" onClick={() => { setView('login'); setError(''); setMessage(''); }}>Sign in</button>}{view === 'login' && <><button type="button" onClick={() => { setView('signup'); setError(''); setMessage(''); }}>Create account</button><button type="button" onClick={() => { setView('reset'); setError(''); setMessage(''); }}>Forgot password?</button></>}</div>
      </form>}
    </>}
    </section></div></main>;
}
