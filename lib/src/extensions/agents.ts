import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { GovernanceRuntime } from '../runtime/governance.ts';
import { decide } from './policy.ts';
import { atomicWrite, textResult, canonical, agentSummary, humanReadable } from '../runtime/utils.ts';

const spec = Type.Object(
  {
    prompt: Type.String({ minLength: 1 }),
    subagent_type: Type.Optional(
      Type.Union([Type.Literal('Explore'), Type.Literal('Plan'), Type.Literal('general-purpose')]),
    ),
    resume: Type.Optional(Type.String({ pattern: '^[0-9a-f-]{36}$' })),
    max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })),
  },
  { additionalProperties: false },
);

export function registerAgents(runtime: GovernanceRuntime, createSession = createAgentSession): void {
  let active = 0;
  const waiters: (() => void)[] = [];

  async function run(input: any, ctx: ExtensionContext, signal?: AbortSignal) {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(input.timeout ?? 600000)]);
    if (active >= 4) await new Promise<void>(resolve => waiters.push(resolve));
    else active++;
    let child: any;
    let remove = () => {};
    const id = input.resume ?? randomUUID();
    try {
      ctx.ui.setStatus('compat-agents', `${active} subagent${active === 1 ? '' : 's'} running`);
      signal?.throwIfAborted();
      if (!ctx.model) throw Error('Select a parent model before delegating');
      const sessions = join(runtime.store, 'agents', 'sessions');
      await mkdir(sessions, { recursive: true });
      const previous = input.resume
        ? JSON.parse(await readFile(join(runtime.store, 'agents', id + '.json'), 'utf8'))
        : undefined;
      if (previous && input.subagent_type && input.subagent_type !== previous.role) {
        throw Error('A resumed agent must keep its original role');
      }
      if (previous && (typeof previous.sessionFile !== 'string' || !/^[-a-zA-Z0-9_.]+\.jsonl$/.test(previous.sessionFile))) {
        throw Error('Invalid saved child session');
      }
      const role = previous?.role ?? input.subagent_type ?? 'general-purpose';
      const manager = previous
        ? SessionManager.open(join(sessions, previous.sessionFile))
        : SessionManager.create(ctx.cwd, sessions);
      const allowed =
        role === 'general-purpose' && runtime.state.mode !== 'plan'
          ? ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']
          : ['read', 'grep', 'find', 'ls'];
      const settings = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: join(homedir(), '.pi/agent'),
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          api => {
            api.on('before_agent_start', () => ({
              systemPrompt: `${ctx.getSystemPrompt()}\n\nYou are a ${role} subagent. Work only on the delegated request. Available tools: ${allowed.join(', ')}. No recursive delegation. Return findings, changed files and verification results. Parent permission policy applies.`,
            }));
            api.on('tool_call', async e => {
              if (!allowed.includes(e.toolName)) return { block: true, reason: 'Tool is outside child allowlist' };
              await runtime.reload(ctx);
              const aliases: Record<string, string> = {
                read: 'Read',
                grep: 'Grep',
                find: 'Glob',
                ls: 'Glob',
                bash: 'Bash',
                write: 'Write',
                edit: 'Edit',
              };
              const normalized = { ...e.input } as any;
              if (['read', 'write', 'edit'].includes(e.toolName)) normalized.file_path = normalized.path;
              const fingerprint = JSON.stringify(runtime.config.permissions);
              const path = normalized.file_path ?? normalized.path;
              const target = typeof path === 'string' ? await canonical(resolve(ctx.cwd, path)) : undefined;
              const decision = await decide(
                aliases[e.toolName],
                normalized,
                runtime.state.mode,
                runtime.config,
                ctx.cwd,
                runtime.state.plan?.path,
              );
              if (
                decision.action === 'deny' ||
                (decision.action === 'ask' &&
                  !(await runtime.approvals.request(ctx, `Subagent ${role}: ${e.toolName}`, humanReadable(normalized), signal)))
              ) {
                return { block: true, reason: decision.reason };
              }
              await runtime.reload(ctx);
              if (
                fingerprint !== JSON.stringify(runtime.config.permissions) ||
                (typeof path === 'string' && target !== (await canonical(resolve(ctx.cwd, path))))
              ) {
                return { block: true, reason: 'Parent policy or child target changed during approval' };
              }
            });
          },
        ],
      });
      await loader.reload();
      const created = await createSession({
        cwd: ctx.cwd,
        model: ctx.model,
        thinkingLevel: ctx.thinkingLevel,
        settingsManager: settings,
        resourceLoader: loader,
        sessionManager: manager,
        tools: allowed,
      });
      child = created.session;
      await child.bindExtensions({
        mode: 'print',
        onError: (error: any) => {
          throw new Error(`Child extension failed: ${String(error.message ?? error)}`);
        },
      });
      const cancel = () => {
        void child.abort();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      remove = () => signal?.removeEventListener('abort', cancel);
      let turns = 0;
      let limited = false;
      const unsubscribe = child.subscribe((e: any) => {
        if (
          e.type === 'turn_end' &&
          ++turns >= (input.max_turns ?? 20) &&
          (e.message?.content ?? []).some((c: any) => c.type === 'toolCall')
        ) {
          limited = true;
          void child.abort();
        }
      });
      try {
        signal?.throwIfAborted();
        await child.prompt(input.prompt);
      } finally {
        unsubscribe();
      }
      signal?.throwIfAborted();
      const assistants = child.messages.filter((m: any) => m.role === 'assistant');
      const last = assistants.at(-1);
      if (last?.stopReason === 'error') throw new Error(last.errorMessage ?? 'Child model failed');
      const output = assistants
        .flatMap((m: any) => m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text))
        .join('\n')
        .slice(-64000);
      const record = {
        id,
        role,
        sessionFile: basename(manager.getSessionFile()!),
        status: limited ? 'turn_limit' : 'completed',
        turns,
        output,
      };
      await atomicWrite(join(runtime.store, 'agents', id + '.json'), JSON.stringify(record));
      return record;
    } finally {
      remove();
      child?.dispose();
      const next = waiters.shift();
      if (next) next();
      else active--;
      ctx.ui.setStatus('compat-agents', active ? `${active} subagent${active === 1 ? '' : 's'} running` : undefined);
    }
  }

  runtime.register(
    spec,
    'Agent',
    'Run an isolated-context Explore, Plan or general-purpose child pi session. Inherits parent model and permissions; child approvals use the parent UI. No recursive delegation. Four children maximum at once.',
    false,
    async (input, ctx, signal) => {
      const result = await run(input, ctx, signal);
      return textResult(agentSummary(result), result);
    },
  );

  runtime.register(
    Type.Object({ agents: Type.Array(spec, { minItems: 1, maxItems: 8 }) }, { additionalProperties: false }),
    'AgentBatch',
    'Run independent delegated requests concurrently; preserve reports when a sibling fails.',
    false,
    async (input, ctx, signal) => {
      const results = await Promise.allSettled(input.agents.map((a: any) => run(a, ctx, signal)));
      const reports = results.map((v: any) =>
        v.status === 'fulfilled' ? v.value : { status: 'failed', error: String(v.reason) },
      );
      return textResult(reports.map(agentSummary).join('\n\n────────\n\n'), { reports });
    },
  );
}
