import { homedir } from 'node:os';
import { join } from 'node:path';
import { optionalText } from './utils.ts';

export type Mode =
  | 'safe'
  | 'ask'
  | 'fullAccess'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

export const modes: Mode[] = [
  'safe',
  'ask',
  'fullAccess',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
];

export interface HookGroup {
  matcher?: string;
  hooks: { type: string; command?: string; timeout?: number }[];
}

export interface Settings {
  permissions: { allow: string[]; ask: string[]; deny: string[]; defaultMode?: Mode };
  hooks: Record<string, HookGroup[]>;
  provenance: Record<string, string[]>;
  diagnostics: string[];
}

export async function loadConfig(cwd: string, trusted: boolean, home = homedir()): Promise<Settings> {
  const result: Settings = { permissions: { allow: [], ask: [], deny: [] }, hooks: {}, provenance: {}, diagnostics: [] };
  const files = [
    join(home, '.pi/settings.json'),
    ...(trusted ? [join(cwd, '.pi/settings.json'), join(cwd, '.pi/settings.local.json')] : []),
  ];
  if (!trusted) result.diagnostics.push('Project executable configuration is disabled until pi project trust is granted.');
  for (const file of files) {
    const raw = await optionalText(file);
    if (raw === undefined) continue;
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in ${file}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Expected settings object: ${file}`);
    for (const [key, value] of Object.entries(data)) {
      (result.provenance[key] ??= []).push(file);
      if (key === 'permissions') {
        if (!value || typeof value !== 'object') throw new Error(`Invalid permissions in ${file}`);
        const p = value as any;
        for (const kind of ['allow', 'ask', 'deny'] as const) {
          if (p[kind] === undefined) continue;
          if (!Array.isArray(p[kind]) || p[kind].some((x: unknown) => typeof x !== 'string')) {
            throw new Error(`Invalid permissions.${kind}: ${file}`);
          }
          for (const rule of p[kind]) {
            if (!/^[A-Za-z][\w]*(?:\(.*\))?$/.test(rule)) throw new Error(`Invalid permission rule ${rule}: ${file}`);
          }
          result.permissions[kind] = [...new Set([...result.permissions[kind], ...p[kind]])];
        }
        if (p.defaultMode !== undefined) {
          if (!modes.includes(p.defaultMode)) throw new Error(`Unsupported permission mode: ${p.defaultMode}`);
          result.permissions.defaultMode = p.defaultMode;
        }
        for (const name of Object.keys(p)) {
          if (!['allow', 'ask', 'deny', 'defaultMode'].includes(name)) {
            result.diagnostics.push(`Unsupported permissions.${name}: ${file}`);
          }
        }
      } else if (key === 'hooks') {
        if (!value || typeof value !== 'object') throw new Error(`Invalid hooks: ${file}`);
        for (const [event, groups] of Object.entries(value)) {
          if (!Array.isArray(groups)) throw new Error(`Invalid hooks.${event}: ${file}`);
          result.hooks[event] = [...(result.hooks[event] ?? []), ...groups];
        }
      } else {
        result.diagnostics.push(`Unsupported setting ${key}: ${file}`);
      }
    }
  }
  return result;
}
