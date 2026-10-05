import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { getConfig } from '../lib/config';
import { errorMessage, useToast } from '../app/toast';
import { Card, ErrorBox, Spinner } from '../components/ui';

export function SettingsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 300_000 });
  const [instructions, setInstructions] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [serviceToken, setServiceToken] = useState('');

  useEffect(() => {
    if (settings.data && instructions === null) {
      setInstructions(settings.data.instructions);
      setDomain(settings.data.domain);
    }
  }, [settings.data, instructions]);

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        instructions: instructions ?? '',
        domain: domain ?? '',
        ...(serviceToken !== '' ? { serviceToken } : {}),
      }),
    onSuccess: (data) => {
      toast.success('Settings saved');
      setServiceToken('');
      queryClient.setQueryData(['settings'], data);
    },
    onError: (e) => toast.error(`Could not save settings: ${errorMessage(e)}`),
  });

  const clearToken = useMutation({
    mutationFn: () => api.saveSettings({ serviceToken: '' }),
    onSuccess: (data) => {
      toast.success('Service token removed');
      queryClient.setQueryData(['settings'], data);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="stack">
      <Card title="Tenant settings">
        {settings.isLoading ? <Spinner /> : null}
        {settings.isError ? <ErrorBox error={settings.error} /> : null}
        {settings.data ? (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="muted small">
              {settings.data.name} · timezone {settings.data.timezone}
            </div>
            <label className="field">
              <span>Instructions for the operator</span>
              <textarea
                data-testid="settings-instructions"
                rows={5}
                maxLength={4000}
                value={instructions ?? ''}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Tone of voice, signature, rules for e-mails…"
              />
              <small className="muted">A short block added to the system prompt. No hidden long-term memory.</small>
            </label>
            <label className="field">
              <span>Company e-mail domain</span>
              <input data-testid="settings-domain" value={domain ?? ''} onChange={(e) => setDomain(e.target.value)} />
            </label>
            <label className="field">
              <span>Service token (for scheduled playbooks)</span>
              <input
                type="password"
                autoComplete="off"
                data-testid="settings-service-token"
                value={serviceToken}
                onChange={(e) => setServiceToken(e.target.value)}
                placeholder={settings.data.hasServiceToken ? '•••••••• stored — type to replace' : 'not set'}
              />
              <small className="muted">
                Write-only: the stored token is never shown.{' '}
                {settings.data.hasServiceToken ? (
                  <button type="button" className="btn btn-link btn-sm" onClick={() => clearToken.mutate()}>
                    Remove stored token
                  </button>
                ) : null}
              </small>
            </label>
            <div className="btn-row">
              <button type="submit" className="btn btn-primary" data-testid="settings-save" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </form>
        ) : null}
      </Card>
      <div className="grid-2">
        <Card title="You">
          {me.data ? (
            <div className="stack-sm">
              <div>
                <strong>{me.data.name}</strong> <span className="muted">{me.data.email}</span>
              </div>
              <div className="muted small">
                {me.data.tenantName} · role {me.data.role}
              </div>
              <div className="chips" data-testid="user-scopes">
                {me.data.scopes.map((s) => (
                  <span key={s} className="chip">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <Spinner />
          )}
        </Card>
        <Card title="Embed in the business app">
          <p className="muted small">
            The <code>&lt;ask-operator&gt;</code> web component adds an “Ask operator” button to any record page of the
            business system. It sends the task together with the record as context.
          </p>
          <pre className="snippet">{`<script type="module" src="${window.location.origin}/embed/ask-operator.js"></script>
<ask-operator agent-url="${getConfig().agentUrl}" token="…"
  record-type="deal" record-id="…" record-label="Acme Logistics – Expansion"
  console-url="${window.location.origin}"></ask-operator>`}</pre>
          <a
            className="btn btn-secondary btn-sm"
            href="/embed-demo.html"
            target="_blank"
            rel="noreferrer"
            data-testid="embed-demo-link"
          >
            Open the embed demo page ↗
          </a>
        </Card>
      </div>
    </div>
  );
}
