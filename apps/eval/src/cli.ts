#!/usr/bin/env node
import { buildFixtures } from './fixtures/build';
import { paths } from './paths';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1] as string);
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  });
  return out;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'run';
  if (command === 'fixtures') {
    const written = await buildFixtures({ outDir: paths.fixtures(), logDir: paths.logs() });
    console.log(`fixtures written: ${written.join(', ')}`);
    return 0;
  }
  if (command === 'diff') {
    const { diffReports } = await import('./diff');
    const [a, b] = process.argv.slice(3).filter((x) => !x.startsWith('--'));
    if (a === undefined || b === undefined) throw new Error('usage: diff <before.json> <after.json>');
    process.stdout.write(diffReports(a, b));
    return 0;
  }
  if (command === 'stack') {
    const { launch } = await import('./launcher');
    const profile = (option('profile')[0] ?? 'dev') as 'dev' | 'e2e' | 'smoke';
    const launched = await launch({
      profile,
      withConsole: flag('console'),
      ...(option('fixture')[0] ? { fixture: option('fixture')[0] as string } : {}),
    });
    console.log(
      JSON.stringify(
        {
          agentUrl: launched.agentUrl,
          consoleUrl: launched.consoleUrl,
          bopApiUrl: launched.bopApiUrl,
          bopWebUrl: launched.bopWebUrl,
          logs: launched.logDir,
          login: 'maria@demo.dev / demo1234',
          bopLogin: 'maria@demo.dev / demo1234 (project 05 SPA with the "Ask operator" panel on record pages)',
        },
        null,
        2,
      ),
    );
    console.log('stack is running; press Ctrl+C to stop');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    await launched.stop();
    return 0;
  }
  if (command === 'run') {
    const { runEval } = await import('./runner');
    const result = await runEval({
      mode: flag('record') ? 'record' : flag('live') ? 'live' : 'replay',
      scenarioIds: option('scenario'),
      categories: option('category'),
      models: option('model'),
      report: !flag('no-report'),
      judge: option('judge')[0] === 'llm' ? 'llm' : 'heuristic',
      ablation: option('ablation')[0] === 'no-guardrails' ? 'no-guardrails' : 'none',
    });
    if (option('ablation')[0] === 'no-guardrails') return result.summary.gatesPassed ? 1 : 0;
    return result.gatesPassed ? 0 : 1;
  }
  console.error(
    `unknown command ${command}; use: run [--record|--live] [--scenario id] [--category c] [--model m] [--ablation=no-guardrails] | fixtures | stack --profile dev|e2e|smoke [--console] | diff <before.json> <after.json>`,
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
