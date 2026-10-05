import { useState, type FormEvent } from 'react';
import type { MeDto } from '@aio/contracts';
import { api } from '../lib/api';
import { getConfig } from '../lib/config';
import { errorMessage } from '../app/toast';

export function LoginPage({ onLogin }: { onLogin: (token: string, me: MeDto) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email.trim(), password);
      onLogin(res.token, res.me);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(e) => void submit(e)} data-testid="login-form">
        <div className="brand brand-lg">
          <span className="brand-mark">AI</span>
          <span className="brand-text">
            Business Operator
            <small>sign in with your business system account</small>
          </span>
        </div>
        <label className="field">
          <span>E-mail</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            data-testid="login-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            data-testid="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error !== null ? (
          <div className="error-box" role="alert" data-testid="login-error">
            {error}
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary btn-block" data-testid="login-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">Agent API: {getConfig().agentUrl}</p>
      </form>
    </div>
  );
}
