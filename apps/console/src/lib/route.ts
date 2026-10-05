export type Route =
  | { name: 'chat' }
  | { name: 'runs' }
  | { name: 'run'; id: string }
  | { name: 'approvals' }
  | { name: 'policy' }
  | { name: 'playbooks' }
  | { name: 'playbook'; id: string }
  | { name: 'usage' }
  | { name: 'eval' }
  | { name: 'evalRun'; id: string }
  | { name: 'settings' }
  | { name: 'login' }
  | { name: 'notFound'; path: string };

export interface ParsedHash {
  path: string;
  query: Record<string, string>;
}

export function splitHash(hash: string): ParsedHash {
  const raw = hash.replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const path = `/${pathPart.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  return { path, query };
}

export function parseRoute(hash: string): Route {
  const { path } = splitHash(hash);
  const parts = path
    .split('/')
    .filter((p) => p !== '')
    .map((p) => decodeURIComponent(p));
  const [head, id, ...rest] = parts;
  if (rest.length > 0) return { name: 'notFound', path };
  if (head === undefined || head === 'chat') return id === undefined ? { name: 'chat' } : { name: 'notFound', path };
  if (head === 'runs') return id === undefined ? { name: 'runs' } : { name: 'run', id };
  if (head === 'playbooks') return id === undefined ? { name: 'playbooks' } : { name: 'playbook', id };
  if (head === 'eval') return id === undefined ? { name: 'eval' } : { name: 'evalRun', id };
  if (id !== undefined) return { name: 'notFound', path };
  switch (head) {
    case 'approvals':
      return { name: 'approvals' };
    case 'policy':
      return { name: 'policy' };
    case 'usage':
      return { name: 'usage' };
    case 'settings':
      return { name: 'settings' };
    case 'login':
      return { name: 'login' };
    default:
      return { name: 'notFound', path };
  }
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'chat':
      return '#/chat';
    case 'runs':
      return '#/runs';
    case 'run':
      return `#/runs/${encodeURIComponent(route.id)}`;
    case 'approvals':
      return '#/approvals';
    case 'policy':
      return '#/policy';
    case 'playbooks':
      return '#/playbooks';
    case 'playbook':
      return `#/playbooks/${encodeURIComponent(route.id)}`;
    case 'usage':
      return '#/usage';
    case 'eval':
      return '#/eval';
    case 'evalRun':
      return `#/eval/${encodeURIComponent(route.id)}`;
    case 'settings':
      return '#/settings';
    case 'login':
      return '#/login';
    case 'notFound':
      return `#${route.path}`;
  }
}

export function navigate(href: string): void {
  const target = href.startsWith('#') ? href : `#${href}`;
  if (window.location.hash !== target) window.location.hash = target;
}
