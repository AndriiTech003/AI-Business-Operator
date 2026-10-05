import type { PolicyDecision, RunEvent, StepDto } from '@aio/contracts';
import { parseSse } from './sse';

const STYLE = `
:host { all: initial; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; display: inline-block; position: relative; }
* { box-sizing: border-box; }
.trigger { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #4f46e5; background: #4f46e5; color: #fff; border-radius: 8px; padding: 7px 12px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.trigger:hover { background: #4338ca; }
.panel { position: absolute; right: 0; top: calc(100% + 8px); width: 380px; max-width: calc(100vw - 32px); background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 12px 32px rgba(17, 24, 39, 0.16); padding: 14px; z-index: 1000; font-size: 13px; }
.panel[hidden] { display: none; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.head strong { font-size: 14px; }
.context { color: #6b7280; font-size: 12px; }
.close { border: 0; background: transparent; font-size: 18px; line-height: 1; cursor: pointer; color: #6b7280; }
textarea { width: 100%; min-height: 70px; resize: vertical; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font: inherit; font-size: 13px; }
textarea:focus { outline: 2px solid #c7d2fe; border-color: #6366f1; }
.row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 8px; }
.send { border: 0; background: #4f46e5; color: #fff; border-radius: 8px; padding: 6px 14px; font: inherit; font-weight: 600; cursor: pointer; }
.send:disabled { opacity: 0.5; cursor: default; }
.status { font-size: 12px; color: #374151; }
.status[data-status="awaiting_approval"] { color: #b45309; }
.status[data-status="completed"] { color: #047857; }
.status[data-status="failed"], .status[data-status="cancelled"] { color: #b91c1c; }
.steps { list-style: none; margin: 10px 0 0; padding: 0; max-height: 160px; overflow: auto; border-top: 1px solid #f3f4f6; }
.steps li { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid #f3f4f6; font-size: 12px; }
.steps code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.badge { border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.badge-allow { background: #ecfdf5; color: #047857; }
.badge-require_approval { background: #fffbeb; color: #b45309; }
.badge-deny { background: #fef2f2; color: #b91c1c; }
.text { white-space: pre-wrap; margin-top: 10px; line-height: 1.45; max-height: 200px; overflow: auto; }
.text:empty { display: none; }
.link { display: inline-block; margin-top: 10px; color: #4f46e5; font-weight: 600; text-decoration: none; }
.link[hidden] { display: none; }
.error { color: #b91c1c; margin-top: 8px; }
.error:empty { display: none; }
.login { display: grid; gap: 6px; }
.login[hidden], .ask[hidden] { display: none; }
.login p { margin: 0 0 2px; color: #374151; font-size: 12px; }
.login input { width: 100%; border: 1px solid #d1d5db; border-radius: 8px; padding: 7px 8px; font: inherit; font-size: 13px; }
.login input:focus { outline: 2px solid #c7d2fe; border-color: #6366f1; }
.signout { display: block; margin-top: 8px; border: 0; background: transparent; color: #6b7280; font: inherit; font-size: 11px; cursor: pointer; padding: 0; text-decoration: underline; }
.signout[hidden] { display: none; }
`;

const TOKEN_KEY = 'aio.embed.session:';

function readStored(agentUrl: string): string {
  try {
    return window.localStorage.getItem(`${TOKEN_KEY}${agentUrl}`) ?? '';
  } catch {
    return '';
  }
}

function writeStored(agentUrl: string, token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(`${TOKEN_KEY}${agentUrl}`);
    else window.localStorage.setItem(`${TOKEN_KEY}${agentUrl}`, token);
  } catch {
    return;
  }
}

const LABEL: Record<PolicyDecision['decision'], string> = {
  allow: 'auto',
  require_approval: 'approval',
  deny: 'blocked',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class AskOperatorElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['record-label', 'record-type'];
  }

  private readonly root: ShadowRoot;
  private readonly panel: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly statusLine: HTMLDivElement;
  private readonly stepList: HTMLUListElement;
  private readonly textBox: HTMLDivElement;
  private readonly link: HTMLAnchorElement;
  private readonly errorBox: HTMLDivElement;
  private readonly contextLine: HTMLSpanElement;
  private readonly loginBox: HTMLDivElement;
  private readonly askBox: HTMLDivElement;
  private readonly emailInput: HTMLInputElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly loginButton: HTMLButtonElement;
  private readonly signOut: HTMLButtonElement;
  private readonly stepNodes = new Map<number, HTMLLIElement>();
  private controller: AbortController | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLE;
    const trigger = el('button', 'trigger', '✦ Ask operator');
    trigger.type = 'button';
    trigger.setAttribute('part', 'button');
    trigger.dataset['testid'] = 'ask-operator-button';
    this.panel = el('div', 'panel');
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    this.panel.dataset['testid'] = 'ask-operator-panel';
    const head = el('div', 'head');
    const title = el('div');
    title.append(el('strong', undefined, 'Ask operator'), el('br'));
    this.contextLine = el('span', 'context');
    title.append(this.contextLine);
    const close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    head.append(title, close);
    this.input = el('textarea');
    this.input.placeholder = 'What should the operator do with this record?';
    this.input.dataset['testid'] = 'ask-operator-input';
    const row = el('div', 'row');
    this.statusLine = el('div', 'status');
    this.statusLine.dataset['testid'] = 'ask-operator-status';
    this.sendButton = el('button', 'send', 'Send');
    this.sendButton.type = 'button';
    this.sendButton.dataset['testid'] = 'ask-operator-send';
    row.append(this.statusLine, this.sendButton);
    this.errorBox = el('div', 'error');
    this.stepList = el('ul', 'steps');
    this.textBox = el('div', 'text');
    this.textBox.dataset['testid'] = 'ask-operator-text';
    this.link = el('a', 'link', 'Open in console →');
    this.link.target = '_blank';
    this.link.rel = 'noopener';
    this.link.hidden = true;
    this.link.dataset['testid'] = 'ask-operator-link';
    this.loginBox = el('div', 'login');
    this.loginBox.dataset['testid'] = 'ask-operator-login';
    this.emailInput = el('input');
    this.emailInput.type = 'email';
    this.emailInput.autocomplete = 'username';
    this.emailInput.placeholder = 'E-mail';
    this.emailInput.dataset['testid'] = 'ask-operator-email';
    this.passwordInput = el('input');
    this.passwordInput.type = 'password';
    this.passwordInput.autocomplete = 'current-password';
    this.passwordInput.placeholder = 'Password';
    this.passwordInput.dataset['testid'] = 'ask-operator-password';
    this.loginButton = el('button', 'send', 'Sign in');
    this.loginButton.type = 'button';
    this.loginButton.dataset['testid'] = 'ask-operator-sign-in';
    this.loginBox.append(
      el('p', undefined, 'Sign in to the AI operator with your business-system account.'),
      this.emailInput,
      this.passwordInput,
      this.loginButton,
    );
    this.askBox = el('div', 'ask');
    this.signOut = el('button', 'signout', 'Sign out');
    this.signOut.type = 'button';
    this.askBox.append(this.input, row);
    this.panel.append(
      head,
      this.loginBox,
      this.askBox,
      this.errorBox,
      this.stepList,
      this.textBox,
      this.link,
      this.signOut,
    );
    this.root.append(style, trigger, this.panel);
    this.loginButton.addEventListener('click', () => void this.signIn());
    this.passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.signIn();
      }
    });
    this.signOut.addEventListener('click', () => {
      writeStored(this.agentUrl(), null);
      this.renderAuth();
    });
    trigger.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => this.toggle(false));
    this.sendButton.addEventListener('click', () => void this.send());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.send();
      }
    });
  }

  connectedCallback(): void {
    this.renderContext();
  }

  disconnectedCallback(): void {
    this.controller?.abort();
  }

  attributeChangedCallback(): void {
    this.renderContext();
  }

  private attr(name: string): string {
    return this.getAttribute(name)?.trim() ?? '';
  }

  private renderContext(): void {
    const label = this.attr('record-label') || this.attr('record-id');
    const type = this.attr('record-type');
    this.contextLine.textContent = label !== '' ? `${type !== '' ? `${type}: ` : ''}${label}` : 'no record context';
  }

  private agentUrl(): string {
    return (this.attr('agent-url') || 'http://127.0.0.1:4600').replace(/\/+$/, '');
  }

  private token(): string {
    return this.attr('token') || readStored(this.agentUrl());
  }

  private renderAuth(): void {
    const signedIn = this.token() !== '';
    this.loginBox.hidden = signedIn;
    this.askBox.hidden = !signedIn;
    this.signOut.hidden = !signedIn || this.attr('token') !== '';
  }

  private async signIn(): Promise<void> {
    const email = this.emailInput.value.trim();
    const password = this.passwordInput.value;
    if (email === '' || password === '') return;
    this.loginButton.disabled = true;
    this.errorBox.textContent = '';
    try {
      const res = await fetch(`${this.agentUrl()}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok)
        throw new Error(res.status === 401 ? 'Invalid e-mail or password.' : `Sign-in failed (HTTP ${res.status}).`);
      const body = (await res.json()) as { token: string };
      writeStored(this.agentUrl(), body.token);
      this.passwordInput.value = '';
      this.renderAuth();
      this.input.focus();
    } catch (error) {
      this.errorBox.textContent = (error as Error).message;
    } finally {
      this.loginButton.disabled = false;
    }
  }

  private toggle(force?: boolean): void {
    const open = force ?? this.panel.hidden;
    this.panel.hidden = !open;
    if (!open) return;
    this.renderAuth();
    if (this.token() === '') this.emailInput.focus();
    else this.input.focus();
  }

  private setStatus(status: string): void {
    this.statusLine.textContent = status;
    this.statusLine.dataset['status'] = status;
  }

  private reset(): void {
    this.stepNodes.clear();
    this.stepList.replaceChildren();
    this.textBox.textContent = '';
    this.errorBox.textContent = '';
    this.link.hidden = true;
  }

  private renderStep(step: StepDto, decision: PolicyDecision | null): void {
    if (step.kind !== 'tool_call' && step.kind !== 'approval') return;
    let li = this.stepNodes.get(step.seq);
    if (li === undefined) {
      li = el('li');
      li.dataset['testid'] = 'ask-operator-step';
      this.stepNodes.set(step.seq, li);
      this.stepList.append(li);
    }
    const d = decision ?? step.policyDecision;
    const children: Node[] = [
      el('code', undefined, step.kind === 'approval' ? `✓ ${step.tool ?? ''}` : (step.tool ?? '')),
    ];
    if (d !== null) {
      const badge = el('span', `badge badge-${d.decision}`, `${LABEL[d.decision]} · ${d.ruleId}`);
      children.push(badge);
    }
    li.replaceChildren(...children);
    this.stepList.scrollTop = this.stepList.scrollHeight;
  }

  private handle(event: RunEvent): void {
    const consoleUrl = (this.attr('console-url') || window.location.origin).replace(/\/+$/, '');
    if (this.link.hidden) {
      this.link.href = `${consoleUrl}/#/runs/${event.runId}`;
      this.link.hidden = false;
    }
    switch (event.type) {
      case 'text':
        this.textBox.textContent = `${this.textBox.textContent ?? ''}${event.delta}`;
        break;
      case 'tool_call':
      case 'tool_result':
      case 'step':
        if (event.step.kind === 'llm_call') {
          const content =
            (event.step.result as { content?: Array<{ type: string; text?: string }> } | null)?.content ?? [];
          const text = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n')
            .trim();
          if (text !== '') this.textBox.textContent = text;
        }
        this.renderStep(event.step, null);
        break;
      case 'policy': {
        const li = this.stepNodes.get(event.seq);
        if (li !== undefined) {
          const badge = el(
            'span',
            `badge badge-${event.decision.decision}`,
            `${LABEL[event.decision.decision]} · ${event.decision.ruleId}`,
          );
          const existing = li.querySelector('.badge');
          if (existing !== null) existing.replaceWith(badge);
          else li.append(badge);
        }
        break;
      }
      case 'status':
        this.setStatus(event.status);
        break;
      case 'done':
        this.setStatus(event.status);
        if (event.summary !== null && event.summary !== '') this.textBox.textContent = event.summary;
        break;
      default:
        break;
    }
  }

  private async send(): Promise<void> {
    const goal = this.input.value.trim();
    if (goal === '' || this.controller !== null) return;
    const agentUrl = this.agentUrl();
    const token = this.token();
    if (token === '') {
      this.renderAuth();
      this.errorBox.textContent = 'Sign in first.';
      return;
    }
    const recordType = this.attr('record-type');
    const recordId = this.attr('record-id');
    const record =
      recordType !== '' && recordId !== ''
        ? {
            type: recordType,
            id: recordId,
            ...(this.attr('record-label') !== '' ? { label: this.attr('record-label') } : {}),
          }
        : undefined;
    this.reset();
    this.setStatus('starting…');
    this.sendButton.disabled = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const res = await fetch(`${agentUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ goal, context: { ...(record !== undefined ? { record } : {}), source: 'embed' } }),
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { title?: string };
          if (typeof body.title === 'string') message = body.title;
        } catch {
          message = `HTTP ${res.status}`;
        }
        if (res.status === 401 && this.attr('token') === '') {
          writeStored(agentUrl, null);
          this.renderAuth();
        }
        throw new Error(res.status === 401 ? 'Session expired: sign in again.' : message);
      }
      this.input.value = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          let event: RunEvent;
          try {
            event = JSON.parse(e.data) as RunEvent;
          } catch {
            continue;
          }
          this.handle(event);
          if (event.type === 'done' || (event.type === 'status' && event.status === 'awaiting_approval'))
            controller.abort();
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.errorBox.textContent = (error as Error).message;
        this.setStatus('error');
      }
    } finally {
      this.controller = null;
      this.sendButton.disabled = false;
    }
  }
}

if (customElements.get('ask-operator') === undefined) customElements.define('ask-operator', AskOperatorElement);

declare global {
  interface HTMLElementTagNameMap {
    'ask-operator': AskOperatorElement;
  }
}
