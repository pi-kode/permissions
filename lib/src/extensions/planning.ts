import { Type } from 'typebox';
import { join, resolve } from 'node:path';
import type { GovernanceRuntime } from '../runtime/governance.ts';
import { canonical, hash, optionalText, textResult, humanReadable } from '../runtime/utils.ts';
import { object } from '../runtime/schema.ts';

export function registerPlanning(runtime: GovernanceRuntime): void {
  runtime.register(
    object({}),
    'EnterPlanMode',
    'Enter read-only planning. Shell/unknown tools are blocked. Only the designated plan file may be edited. ExitPlanMode requires explicit UI approval of its content hash.',
    true,
    async () => {
      if (runtime.state.mode !== 'plan') {
        const path = await canonical(join(runtime.store, 'plans', 'plan.md'));
        runtime.state.plan = { path, previousMode: runtime.state.mode, status: 'draft' };
        runtime.state.mode = 'plan';
        runtime.persist();
      } else if (!runtime.state.plan) {
        runtime.state.plan = {
          path: await canonical(join(runtime.store, 'plans', 'plan.md')),
          previousMode: 'safe',
          status: 'draft',
        };
        runtime.persist();
      }
      return textResult(
        `Plan mode active. Write the plan to ${runtime.state.plan!.path}. Source edits and shell execution are blocked.`,
        { plan: runtime.state.plan },
      );
    },
  );

  runtime.register(
    object({}),
    'ExitPlanMode',
    'Present the current plan for explicit approval through the user UI. Approval is bound to the plan SHA-256; denial keeps plan mode active.',
    true,
    async (_input, ctx, signal) => {
      const plan = runtime.state.plan;
      if (runtime.state.mode !== 'plan' || !plan) throw new Error('Enter plan mode first');
      const text = await optionalText(plan.path);
      if (!text?.trim()) throw new Error('Write a non-empty plan before requesting approval');
      const revision = hash(text);
      const approved = await runtime.approvals.request(
        ctx,
        `Approve plan ${revision.slice(0, 12)}?`,
        `${plan.path}\n\n${text}`,
        signal,
      );
      const current = await optionalText(plan.path);
      if (current === undefined || hash(current) !== revision) {
        throw new Error('Plan changed during approval; review the revised plan');
      }
      plan.status = approved ? 'approved' : 'rejected';
      if (approved) {
        plan.approvedHash = revision;
        runtime.state.mode = plan.previousMode;
      }
      runtime.persist();
      return textResult(
        approved
          ? `Approved plan ${revision}. Mode restored to ${runtime.state.mode}.`
          : 'Plan was not approved. Remain in plan mode.',
        { approved, revision },
      );
    },
  );

  runtime.register(
    object({
      questions: Type.Array(
        object({
          question: Type.String({ minLength: 1 }),
          header: Type.String(),
          options: Type.Array(object({ label: Type.String(), description: Type.String() }), { minItems: 2, maxItems: 4 }),
          multiSelect: Type.Optional(Type.Literal(false)),
        }),
        { minItems: 1, maxItems: 4 },
      ),
    }),
    'AskUserQuestion',
    'Ask up to four questions via TUI/RPC. Single-select options and a free-text answer are supported. Unattended execution fails explicitly.',
    true,
    async (input, ctx, signal) => {
      if (!ctx.hasUI) throw new Error('AskUserQuestion requires a connected TUI or RPC UI');
      const answers: Record<string, string> = {};
      for (const question of input.questions) {
        const other = '[Enter a custom answer]';
        const selected = await ctx.ui.select(
          question.question,
          [...question.options.map((o: any) => `${o.label}: ${o.description}`), other],
          { signal },
        );
        if (!selected) throw new Error('Question cancelled');
        const answer = selected === other ? await ctx.ui.input(question.question, '', { signal }) : selected;
        if (answer === undefined) throw new Error('Question cancelled');
        answers[question.question] = answer;
      }
      return textResult(humanReadable({ answers }), { answers });
    },
  );

  runtime.pi.on('before_agent_start', () => {
    if (!runtime.ready || runtime.state.mode !== 'plan') return;
    return {
      message: {
        customType: 'code-compat:plan',
        content: `Plan mode is active. Do not mutate source files or run shell commands. Write only the designated plan artifact (${runtime.state.plan?.path ?? 'plan.md'}) and request approval with ExitPlanMode.`,
        display: false,
      },
    };
  });

  runtime.pi.on('tool_call', async (e, ctx) => {
    if (runtime.state.mode !== 'plan' || runtime.tools.has(e.toolName)) return;
    if (['read', 'Read', 'grep', 'Grep', 'find', 'Glob', 'ls', 'TaskGet', 'TaskList', 'TaskOutput'].includes(e.toolName)) {
      return;
    }
    const input = e.input as any;
    const rawPath = input.file_path ?? input.path;
    if (['write', 'Write', 'edit', 'Edit'].includes(e.toolName) && typeof rawPath === 'string') {
      if ((await canonical(resolve(ctx.cwd, rawPath))) === runtime.state.plan?.path) return;
    }
    return {
      block: true,
      reason: 'Plan mode restricts mutations to the designated plan file. Approve the plan with ExitPlanMode.',
    };
  });

  runtime.pi.on('user_bash', () =>
    runtime.state.mode === 'plan'
      ? { result: { output: 'Shell is blocked during planning.', exitCode: 1, cancelled: false, truncated: false } }
      : undefined,
  );
}
