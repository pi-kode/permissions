import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function within(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function canonical(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(file);
    if (parent === file) return file;
    return resolve(await canonical(parent), relative(parent, file));
  }
}

export async function atomicWrite(file: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await writeFile(temp, contents, { mode, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function optionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

export const textResult = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: 'text' as const, text }],
  details,
});

export function humanReadable(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'object') return String(value);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index + 1), item] as const)
    : Object.entries(value);
  if (!entries.length) return 'None';
  return entries
    .map(([key, item]) => {
      const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
      return item !== null && typeof item === 'object'
        ? `${indent}${label}:\n${humanReadable(item, indent + '  ')}`
        : `${indent}${label}: ${humanReadable(item)}`;
    })
    .join('\n');
}

export function agentSummary(report: {
  id?: string;
  role?: string;
  status: string;
  turns?: number;
  output?: string;
  error?: string;
}): string {
  return [
    `${report.role ?? 'Subagent'} — ${report.status.replace(/_/g, ' ')}`,
    report.id ? `Agent ID: ${report.id}` : '',
    report.turns !== undefined ? `Turns: ${report.turns}` : '',
    report.error ? `Error: ${report.error}` : '',
    report.output || '',
  ]
    .filter(Boolean)
    .join('\n');
}
