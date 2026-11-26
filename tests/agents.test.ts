import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGovernance } from '../lib/src/features/permissions.ts';
import { harness } from './helper.ts';

test('separate child sessions, bounded concurrency, sibling failures retained and cleanup', async t => {
  let active = 0;
  let peak = 0;
  let disposed = 0;
  const create: any = async (options: any) => {
    assert.ok(options.tools.includes('read'));
    assert.ok(!options.tools.includes('Agent'));
    const session: any = {
      messages: [],
      bindExtensions: async () => {},
      subscribe: () => () => {},
      abort: async () => {},
      dispose: () => disposed++,
      prompt: async (prompt: string) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise(r => setTimeout(r, 10));
          if (prompt === 'fail') throw Error('child failure');
          session.messages = [{ role: 'assistant', content: [{ type: 'text', text: prompt }], stopReason: 'stop' }];
        } finally {
          active--;
        }
      },
    };
    return { session };
  };
  const h = await harness(pi => installGovernance(pi, create));
  t.after(() => h.close());
  const result = await h.call('AgentBatch', {
    agents: Array.from({ length: 8 }, (_, i) => ({
      prompt: i === 3 ? 'fail' : 'child ' + i,
      subagent_type: 'Explore',
    })),
  });
  assert.equal(result.details.reports.length, 8);
  assert.equal(result.details.reports.filter((r: any) => r.status === 'failed').length, 1);
  assert.ok(peak <= 4);
  assert.equal(disposed, 8);
});

test('Explore child receives read-only tools and cancellation releases its session', async t => {
  let disposed = false;
  const create: any = async (options: any) => {
    assert.ok(!options.tools.includes('bash'));
    return {
      session: {
        messages: [],
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {
          disposed = true;
        },
      },
    };
  };
  const h = await harness(pi => installGovernance(pi, create));
  t.after(() => h.close());
  await h.call('Agent', { prompt: 'inspect', subagent_type: 'Explore' });
  assert.equal(disposed, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call('Agent', { prompt: 'inspect' }, controller.signal));
});

test('real SDK child binds policy extension and denies forbidden child tool calls', async t => {
  const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
  let blocked = false;
  const create: any = async (options: any) => {
    const extension = options.resourceLoader.getExtensions().extensions[0];
    const gate = extension.handlers.get('tool_call')[0];
    blocked = (await gate({ toolName: 'bash', input: { command: 'echo forbidden' } }))?.block === true;
    const result = await createAgentSession(options);
    result.session.prompt = async () => {};
    return result;
  };
  const h = await harness(pi => installGovernance(pi, create));
  t.after(() => h.close());
  h.ctx.model = {
    id: 'offline-test',
    name: 'Offline test',
    provider: 'anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
  await h.call('Agent', { prompt: 'inspect', subagent_type: 'Explore' });
  assert.equal(blocked, true);
});

test('saved child ID resumes its session and cannot change role', async t => {
  let invocations = 0;
  const create: any = async (options: any) => {
    if (invocations++) {
      assert.ok(options.sessionManager.getEntries().some((e: any) => e.type === 'message' && e.message.role === 'user'));
    }
    const session: any = {
      messages: [],
      bindExtensions: async () => {},
      subscribe: () => () => {},
      abort: async () => {},
      dispose: () => {},
      prompt: async (prompt: string) => {
        options.sessionManager.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
        session.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }];
      },
    };
    return { session };
  };
  const h = await harness(pi => installGovernance(pi, create));
  t.after(() => h.close());
  const first = await h.call('Agent', { prompt: 'inspect', subagent_type: 'Explore' });
  const next = await h.call('Agent', { prompt: 'continue', resume: first.details.id });
  assert.equal(next.details.id, first.details.id);
  await assert.rejects(
    h.call('Agent', { prompt: 'change role', resume: first.details.id, subagent_type: 'general-purpose' }),
    /original role/,
  );
});
