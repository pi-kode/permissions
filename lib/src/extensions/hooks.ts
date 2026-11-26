import type { GovernanceRuntime } from '../runtime/governance.ts';
import { runProcess } from '../backends/process.ts';
import type { CompatEvent, HookOutcome } from '../runtime/events.ts';
import type { Settings } from '../runtime/config.ts';

export class Hooks {
  async run(
    event: CompatEvent,
    payload: Record<string, unknown>,
    config: Settings,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<HookOutcome> {
    const outcome: HookOutcome = { context: [] };
    for (const group of config.hooks[event] ?? []) {
      if (!group || !Array.isArray(group.hooks)) throw new Error(`Invalid ${event} hook group`);
      if (group.matcher && group.matcher !== '*') {
        const names = group.matcher.split('|');
        if (names.some(x => !/^[\w]+$/.test(x))) throw new Error(`Unsupported hook matcher: ${group.matcher}`);
        if (!names.includes(String(payload.tool_name ?? ''))) continue;
      }
      for (const hook of group.hooks) {
        if (hook.type !== 'command' || !hook.command) throw new Error(`Unsupported ${event} hook type: ${hook.type}`);
        const result = await runProcess('/bin/sh', ['-c', hook.command], {
          cwd,
          signal,
          timeout: Math.min(Math.max((hook.timeout ?? 30) * 1000, 1), 120_000),
          input: JSON.stringify({ ...payload, hook_event_name: event, cwd }) + '\n',
          env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        });
        if (result.timedOut || result.cancelled || result.truncated) {
          throw new Error(`${event} hook timed out, was cancelled, or exceeded output limit`);
        }
        if (result.exitCode === 2) {
          outcome.deny = (result.stderr || result.stdout).trim() || `${event} hook blocked the operation`;
          continue;
        }
        if (result.exitCode !== 0) throw new Error(`${event} hook failed (${result.exitCode}): ${result.output}`);
        if (!result.stdout.trim()) continue;
        let json: any;
        try {
          json = JSON.parse(result.stdout);
        } catch {
          if (/^\s*[\[{]/.test(result.stdout)) throw new Error(`Invalid ${event} hook JSON`);
          outcome.context.push(result.stdout);
          continue;
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`Invalid ${event} hook response`);
        if (['PreToolUse', 'PermissionRequest'].includes(event) && json.decision === 'block') {
          outcome.deny = json.reason ?? 'Hook blocked the operation';
        }
        if (json.continue === false) outcome.deny = json.stopReason ?? 'Hook requested stop';
        const specific = json.hookSpecificOutput;
        if (specific?.hookEventName && specific.hookEventName !== event) throw new Error('Hook response event mismatch');
        if (specific?.permissionDecision === 'deny') {
          outcome.deny = specific.permissionDecisionReason ?? 'Hook denied operation';
        }
        if (specific?.updatedInput) {
          if (typeof specific.updatedInput !== 'object' || Array.isArray(specific.updatedInput)) {
            throw new Error('Invalid hook updatedInput');
          }
          outcome.updatedInput = specific.updatedInput;
          payload.tool_input = specific.updatedInput;
        }
        if (specific?.additionalContext) outcome.context.push(String(specific.additionalContext));
        if (event === 'Stop' && json.decision === 'block') {
          outcome.continueReason = json.reason ?? 'Continue working.';
        }
      }
    }
    return outcome;
  }
}

export function registerStopHook(runtime: GovernanceRuntime): void {
  let stopActive = false;
  runtime.pi.on('agent_before_settle', async (_event, ctx) => {
    if (!runtime.ready) return;
    const result = await runtime.hooks.run('Stop', { stop_hook_active: stopActive }, runtime.config, ctx.cwd, ctx.signal);
    if ((result.continueReason || result.deny) && !stopActive) {
      stopActive = true;
      return {
        continue: true,
        entries: [
          {
            type: 'custom_message' as const,
            customType: 'code-compat:stop',
            content: result.continueReason ?? result.deny!,
            display: false,
          },
        ],
      };
    }
  });
  runtime.pi.on('agent_settled', () => {
    stopActive = false;
  });
}
