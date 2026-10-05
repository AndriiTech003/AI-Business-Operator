import { lazy, Suspense, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeDto } from '@aio/contracts';
import { api, readToken, setUnauthorizedHandler, writeToken } from '../lib/api';
import { liveRuns } from '../lib/live';
import { navigate, routeHref, type Route } from '../lib/route';
import { useRoute } from './hooks';
import { ToastProvider } from './toast';
import { Spinner } from '../components/ui';
import { LoginPage } from '../pages/LoginPage';
import { ChatPage } from '../pages/ChatPage';
import { RunPage } from '../pages/RunPage';
import { RunsPage } from '../pages/RunsPage';
import { ApprovalsPage } from '../pages/ApprovalsPage';
import { PlaybooksPage } from '../pages/PlaybooksPage';
import { PlaybookPage } from '../pages/PlaybookPage';
import { UsagePage } from '../pages/UsagePage';
import { EvalPage } from '../pages/EvalPage';
import { EvalRunPage } from '../pages/EvalRunPage';
import { SettingsPage } from '../pages/SettingsPage';

const PolicyPage = lazy(() => import('../pages/PolicyPage').then((m) => ({ default: m.PolicyPage })));

const REDIRECT_KEY = 'aio.redirect';

interface NavItem {
  route: Route;
  label: string;
  icon: string;
  match: Route['name'][];
}

const NAV: NavItem[] = [
  { route: { name: 'chat' }, label: 'Operator chat', icon: '✦', match: ['chat'] },
  { route: { name: 'runs' }, label: 'Runs', icon: '≡', match: ['runs', 'run'] },
  { route: { name: 'approvals' }, label: 'Approvals', icon: '✓', match: ['approvals'] },
  { route: { name: 'policy' }, label: 'Policy', icon: '§', match: ['policy'] },
  { route: { name: 'playbooks' }, label: 'Playbooks', icon: '↻', match: ['playbooks', 'playbook'] },
  { route: { name: 'usage' }, label: 'Usage', icon: '$', match: ['usage'] },
  { route: { name: 'eval' }, label: 'Eval', icon: '◎', match: ['eval', 'evalRun'] },
  { route: { name: 'settings' }, label: 'Settings', icon: '⚙', match: ['settings'] },
];

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function rememberRedirect(): void {
  const hash = window.location.hash;
  if (hash === '' || hash.startsWith('#/login')) return;
  try {
    window.sessionStorage.setItem(REDIRECT_KEY, hash);
  } catch {
    return;
  }
}

function takeRedirect(): string {
  try {
    const v = window.sessionStorage.getItem(REDIRECT_KEY);
    window.sessionStorage.removeItem(REDIRECT_KEY);
    return v ?? '#/chat';
  } catch {
    return '#/chat';
  }
}

function Shell() {
  const route = useRoute();
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => readToken());

  useEffect(() => {
    setUnauthorizedHandler(() => {
      writeToken(null);
      setToken(null);
      queryClient.clear();
      rememberRedirect();
      navigate('#/login');
    });
  }, [queryClient]);

  useEffect(() => {
    return liveRuns.onStreamEnd((runId) => {
      void queryClient.invalidateQueries({ queryKey: ['run', runId] });
      void queryClient.invalidateQueries({ queryKey: ['proposals'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    });
  }, [queryClient]);

  useEffect(() => {
    if (token === null && route.name !== 'login') {
      rememberRedirect();
      navigate('#/login');
    } else if (token !== null && route.name === 'login') navigate('#/chat');
  }, [token, route.name]);

  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: token !== null, staleTime: 300_000 });

  if (token === null) {
    return (
      <LoginPage
        onLogin={(t: string, profile: MeDto) => {
          writeToken(t);
          queryClient.setQueryData(['me'], profile);
          setToken(t);
          navigate(takeRedirect());
        }}
      />
    );
  }

  const logout = () => {
    writeToken(null);
    setToken(null);
    queryClient.clear();
    navigate('#/login');
  };

  return (
    <div className="layout">
      <Sidebar route={route} />
      <div className="main">
        <header className="topbar">
          <div className="topbar-title">{pageTitle(route)}</div>
          <div className="topbar-user" data-testid="current-user">
            {me.data ? (
              <>
                <span className="avatar" aria-hidden="true">
                  {initials(me.data.name)}
                </span>
                <span className="user-meta">
                  <strong>{me.data.name}</strong>
                  <small>
                    {me.data.tenantName} · {me.data.role}
                  </small>
                </span>
              </>
            ) : (
              <span className="muted">{me.isError ? 'Not connected' : 'Loading…'}</span>
            )}
            <button type="button" className="btn btn-ghost btn-sm" data-testid="logout" onClick={logout}>
              Log out
            </button>
          </div>
        </header>
        <main className="content">
          <Page route={route} />
        </main>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((p) => p !== '')
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function Sidebar({ route }: { route: Route }) {
  const pending = useQuery({
    queryKey: ['proposals', 'pending'],
    queryFn: () => api.proposals('pending'),
    refetchInterval: 10_000,
  });
  const pendingCount =
    pending.data?.batches.reduce((n, b) => n + b.proposals.filter((p) => p.status === 'pending').length, 0) ?? 0;
  return (
    <nav className="sidebar" aria-label="Main">
      <a className="brand" href="#/chat">
        <span className="brand-mark">AI</span>
        <span className="brand-text">
          Business Operator
          <small>agent console</small>
        </span>
      </a>
      <ul className="nav">
        {NAV.map((item) => (
          <li key={item.label}>
            <a
              href={routeHref(item.route)}
              className={item.match.includes(route.name) ? 'nav-link active' : 'nav-link'}
              data-testid={`nav-${item.route.name}`}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="nav-label">{item.label}</span>
              {item.route.name === 'approvals' && pendingCount > 0 ? (
                <span className="nav-count" data-testid="pending-count">
                  {pendingCount}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function pageTitle(route: Route): string {
  switch (route.name) {
    case 'chat':
      return 'Operator chat';
    case 'runs':
      return 'Runs';
    case 'run':
      return 'Run';
    case 'approvals':
      return 'Approvals';
    case 'policy':
      return 'Policy';
    case 'playbooks':
      return 'Playbooks';
    case 'playbook':
      return 'Playbook';
    case 'usage':
      return 'Usage';
    case 'eval':
      return 'Eval dashboard';
    case 'evalRun':
      return 'Eval run';
    case 'settings':
      return 'Settings';
    case 'login':
      return 'Sign in';
    case 'notFound':
      return 'Not found';
  }
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'chat':
      return <ChatPage />;
    case 'runs':
      return <RunsPage />;
    case 'run':
      return <RunPage key={route.id} id={route.id} />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'policy':
      return (
        <Suspense fallback={<Spinner label="Loading the policy editor…" />}>
          <PolicyPage />
        </Suspense>
      );
    case 'playbooks':
      return <PlaybooksPage />;
    case 'playbook':
      return <PlaybookPage key={route.id} id={route.id} />;
    case 'usage':
      return <UsagePage />;
    case 'eval':
      return <EvalPage />;
    case 'evalRun':
      return <EvalRunPage key={route.id} id={route.id} />;
    case 'settings':
      return <SettingsPage />;
    case 'login':
      return null;
    case 'notFound':
      return (
        <div className="empty">
          <h2>Page not found</h2>
          <p>
            Nothing lives at <code>{route.path}</code>. <a href="#/chat">Go to the operator chat</a>.
          </p>
        </div>
      );
  }
}
