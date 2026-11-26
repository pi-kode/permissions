export type CompatEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'PreCompact'
  | 'PostCompact'
  | 'TaskCompleted';

export interface HookOutcome {
  deny?: string;
  updatedInput?: Record<string, unknown>;
  context: string[];
  continueReason?: string;
}
