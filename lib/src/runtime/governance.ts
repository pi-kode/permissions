import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Check } from 'typebox/value';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Approvals } from './approvals.ts';
import { loadConfig, type Mode, type Settings } from './config.ts';
import { hash, textResult } from './utils.ts';
import { Hooks } from '../extensions/hooks.ts';

export interface PlanState {
  path: string;
  previousMode: Mode;
  approvedHash?: string;
  status: 'draft' | 'approved' | 'rejected';
}

export interface GovernanceState {
  version: 1;
  mode: Mode;
  plan?: PlanState;
}

export const initialState = (): GovernanceState => ({ version: 1, mode: 'safe' });

function normalizeMode(mode: unknown): Mode {
  return typeof mode === 'string' && mode !== 'default' ? (mode as Mode) : 'safe';
}

export function restoreState(entries: readonly any[]): GovernanceState {
  let state = initialState();
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'code-compat:state' && entry.data?.version === 1) {
      const plan = entry.data.plan ? structuredClone(entry.data.plan) : undefined;
      if (plan) plan.previousMode = normalizeMode(plan.previousMode);
      state = {
        version: 1,
        mode: normalizeMode(entry.data.mode),
        ...(plan ? { plan } : {}),
      };
    }
  }
  return state;
}

export class GovernanceRuntime {
  pi: ExtensionAPI;
  readonly approvals = new Approvals();
  readonly hooks = new Hooks();
  readonly tools = new Set<string>();
  state: GovernanceState = initialState();
  config: Settings = { permissions: { allow: [], ask: [], deny: [] }, hooks: {}, provenance: {}, diagnostics: [] };
  cwd = '';
  store = '';
  ready = false;
  private uiContext?: ExtensionContext;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.ready = false;
    this.cwd = ctx.cwd;
    this.state = restoreState(ctx.sessionManager.getBranch());
    this.store = join(
      homedir(),
      '.local/share/pi-code-compat',
      hash(ctx.cwd).slice(0, 24),
      hash(ctx.sessionManager.getSessionId()).slice(0, 24),
    );
    await this.reload(ctx);
    if (!ctx.sessionManager.getBranch().some((e: any) => e.customType === 'code-compat:state')) {
      this.state.mode = this.config.permissions.defaultMode ?? 'safe';
    }
    const startup = await this.hooks.run(
      'SessionStart',
      { source: 'startup', session_id: ctx.sessionManager.getSessionId() },
      this.config,
      this.cwd,
      ctx.signal,
    );
    if (startup.deny) throw new Error(startup.deny);
    this.ready = true;
    this.status(ctx);
  }

  async reload(ctx: ExtensionContext): Promise<void> {
    this.config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
  }

  persist(): void {
    this.pi.appendEntry('code-compat:state', structuredClone(this.state));
    if (this.uiContext) this.status(this.uiContext);
  }

  status(ctx: ExtensionContext): void {
    this.uiContext = ctx;
    ctx.ui.setStatus('code-compat', `PK ${this.state.mode}`);
  }

  message(content: string): void {
    this.pi.sendMessage({ customType: 'code-compat', content, display: true });
  }

  register(
    schema: TSchema,
    name: string,
    description: string,
    write: boolean,
    backend: (input: any, ctx: ExtensionContext, signal?: AbortSignal) => Promise<ReturnType<typeof textResult>>,
  ): void {
    this.tools.add(name);
    const tool: ToolDefinition<any, any> = {
      name,
      label: name,
      description,
      parameters: schema,
      executionMode: write ? 'sequential' : 'parallel',
      execute: async (_id, raw, signal, _update, ctx) => {
        if (!this.ready) throw new Error('Governance runtime is unavailable');
        const input: any = structuredClone(raw);
        if (!Check(schema, input)) throw new Error(`Invalid ${name} input`);
        await this.reload(ctx);
        const result = await backend(input, ctx, signal);
        this.status(ctx);
        return result;
      },
    };
    this.pi.registerTool(tool);
  }
}
