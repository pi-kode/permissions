import { isAbsolute, matchesGlob, resolve } from 'node:path';
import type { Settings, Mode } from '../runtime/config.ts';
import { canonical, within } from '../runtime/utils.ts';

export interface Decision {
  action: 'allow' | 'ask' | 'deny';
  reason: string;
}

const readonly = new Set(['Read', 'Glob', 'Grep', 'TaskGet', 'TaskList', 'TaskOutput']);
const workflow = new Set(['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'TaskStop']);

export async function decide(
  name: string,
  input: Record<string, any>,
  mode: Mode,
  config: Settings,
  cwd: string,
  planPath?: string,
): Promise<Decision> {
  const originalName = name;
  if (name === 'TaskRun') name = 'Bash';
  if (name === 'AgentBatch') name = 'Agent';
  if (name === 'NotebookEdit') {
    name = 'Edit';
    input = { ...input, file_path: input.notebook_path };
  }
  const readAgent =
    name === 'Agent' &&
    (input.agents
      ? input.agents.every((a: any) => ['Explore', 'Plan'].includes(a.subagent_type))
      : ['Explore', 'Plan'].includes(input.subagent_type));
  const file =
    typeof (input.file_path ?? input.notebook_path) === 'string'
      ? await canonical(resolve(cwd, input.file_path ?? input.notebook_path))
      : undefined;

  if (mode === 'plan' && !readAgent && !readonly.has(name) && !workflow.has(name)) {
    if (!(name === 'Write' || name === 'Edit' || name === 'NotebookEdit') || !file || file !== planPath) {
      return {
        action: 'deny',
        reason: 'Plan mode permits only reads, workflow tools and the designated plan artifact. Shell and alternate tools are blocked.',
      };
    }
  }
  if (mode === 'ask' || mode === 'fullAccess') {
    for (const rule of config.permissions.deny) {
      if (
        (await matchesRule(rule, name, input, cwd, file, 'deny')) ||
        (originalName !== name && (await matchesRule(rule, originalName, input, cwd, file, 'deny')))
      ) {
        return { action: 'deny', reason: `deny rule: ${rule}` };
      }
    }
    return mode === 'ask'
      ? { action: 'ask', reason: 'Ask Everything mode requires approval for every call' }
      : { action: 'allow', reason: 'Full Access mode' };
  }
  for (const kind of ['deny', 'ask', 'allow'] as const) {
    for (const rule of config.permissions[kind]) {
      if (
        (await matchesRule(rule, name, input, cwd, file, kind)) ||
        (originalName !== name && (await matchesRule(rule, originalName, input, cwd, file, kind)))
      ) {
        return {
          action: kind === 'deny' || (kind === 'ask' && mode === 'dontAsk') ? 'deny' : kind === 'ask' ? 'ask' : 'allow',
          reason: `${kind} rule: ${rule}`,
        };
      }
    }
  }
  if (mode === 'bypassPermissions') return { action: 'allow', reason: 'Explicit bypassPermissions mode (no sandbox)' };
  if (readonly.has(name)) {
    const target = file ?? (await canonical(resolve(cwd, input.path ?? '.')));
    if (within(await canonical(cwd), target)) return { action: 'allow', reason: 'Read inside workspace' };
  }
  if (readAgent) return { action: 'allow', reason: 'Read-only child context' };
  if (workflow.has(name)) return { action: 'allow', reason: 'Workflow operation; approvals are enforced by its state machine' };
  if (
    (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') &&
    file &&
    ((mode === 'acceptEdits' && within(await canonical(cwd), file)) || (mode === 'plan' && file === planPath))
  ) {
    return { action: 'allow', reason: 'Allowed file edit in current mode' };
  }
  if (mode === 'dontAsk') return { action: 'deny', reason: 'dontAsk denies operations without an allow decision' };
  return { action: 'ask', reason: 'Operation needs explicit approval' };
}

export async function matchesRule(
  rule: string,
  name: string,
  input: Record<string, any>,
  cwd: string,
  canonicalFile?: string,
  kind: 'allow' | 'ask' | 'deny' = 'allow',
): Promise<boolean> {
  const match = /^([A-Za-z][\w]*)(?:\((.*)\))?$/.exec(rule);
  if (!match || match[1] !== name) return false;
  if (match[2] === undefined || match[2] === '*') return true;
  const pattern = match[2];
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'].includes(name)) {
    const supplied = resolve(cwd, input.file_path ?? input.path ?? '.');
    const resolved = canonicalFile ?? (await canonical(supplied));
    const absolutePattern = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
    const lexicalMatch = matchesGlob(supplied, absolutePattern);
    const resolvedMatch = matchesGlob(resolved, absolutePattern);
    return kind === 'allow' ? lexicalMatch && resolvedMatch : lexicalMatch || resolvedMatch;
  }
  if (name === 'Bash') {
    const variants = commandVariants(String(input.command ?? ''), cwd);
    if (pattern.endsWith(':*')) {
      const prefix = shellWords(pattern.slice(0, -2));
      if (!prefix) return kind !== 'allow';
      const parsed = variants.map(command => shellWords(command));
      if (!parsed.some(tokens => tokens)) return kind !== 'allow';
      return parsed.some(
        tokens => !!tokens && tokens.length >= prefix.length && prefix.every((word, index) => tokens[index] === word),
      );
    }
    if (pattern.includes('*') || pattern.includes(':')) return kind !== 'allow';
    return variants.includes(pattern);
  }
  return kind !== 'allow';
}

export function withoutRedundantCd(command: string, cwd: string): string | undefined {
  const match = /^\s*cd\s+([^\r\n]+?)\s*&&\s*([^\r\n]*)$/.exec(command);
  if (!match) return;
  const words = shellWords(`cd ${match[1]}`);
  if (!words || words.length !== 2 || words[0] !== 'cd') return;
  if (resolve(cwd, words[1]) !== resolve(cwd)) return;
  return match[2].trim() || undefined;
}

function commandVariants(command: string, cwd: string): string[] {
  const variants = [command];
  let next = withoutRedundantCd(command, cwd);
  while (next && !variants.includes(next)) {
    variants.push(next);
    next = withoutRedundantCd(next, cwd);
  }
  return variants;
}

export function shellWords(command: string): string[] | undefined {
  if (/[\r\n]/.test(command)) return;
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (c === '\\') {
      if (quote === '"') return;
      if (i + 1 >= command.length) return;
      word += command[++i];
      started = true;
      continue;
    }
    if (c === '$' || c === '`') return;
    if (quote === '"') {
      if (c === '"') quote = '';
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (/[;&|<>(){}*?!~#]/.test(c)) return;
    if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    word += c;
    started = true;
  }
  if (quote) return;
  if (started) words.push(word);
  return words.length ? words : undefined;
}
