# @pi-kode/permissions

Standalone `pi` governance extension providing tool permissions, planning mode, lifecycle hooks, and policy-enforced subagents.

## Capabilities

### 1. Permissions and policy rules

Intercepts tool calls and evaluates them against the active permission mode and configured `allow`, `ask`, and `deny` rules.

#### Permission modes

Run `/permissions` or `/permissions mode` to open the mode picker, or switch directly with `/permissions mode <mode>`:

- **Safe** (`safe`, default): automatically allows workspace reads (`Read`, `Glob`, `Grep`, `TaskGet`, `TaskList`, `TaskOutput` within the workspace), read-only subagents (`Explore`, `Plan`), and workflow tools. File mutations, shell commands, and other operations require approval unless matched by an `allow` rule.
- **Ask Everything** (`ask`): requires approval before every tool call, including reads and calls covered by `allow` rules. Session approvals are not reused. Explicit `deny` rules still block.
- **Full Access** (`fullAccess`): allows operations without approval, including those covered by `ask` rules. Explicit `deny` rules still apply. Full Access does not grant operating-system privileges or bypass external sandboxes.

Legacy modes (`acceptEdits`, `dontAsk`, `bypassPermissions`) remain supported; legacy `default` session state is normalized to `safe` on restore. Mode selection is persisted per session branch.

Use `/permissions status` (or any `/permissions` command) to inspect the active mode, loaded rules, session approval count, and session wildcard rules.

#### Interactive approvals and session grants

When a tool call requires approval, the UI prompts with:

- `Allow once`
- `Allow this exact call for session` (bound to tool name, input hash, canonical target path, policy fingerprint, and mode; not offered in `ask` mode)
- Session wildcard rules where applicable, such as `Bash(<prefix>:*)`, `Edit(<dir>/**)`, or `Grep(<dir>/**)` (not offered in `ask` mode)
- `Deny`

Before allowing execution after an approval prompt, the extension re-checks the policy fingerprint, input hash, and canonical path so changes during approval are rejected. Session grants and session rules persist in the session branch and are restored on session load or tree navigation.

#### Policy rules and tool aliasing

Add persistent project rules with `/permissions allow <Rule>`, `/permissions ask <Rule>`, or `/permissions deny <Rule>` (saved to `.pi/settings.local.json`; requires project trust).

Rules are evaluated in order: `deny`, then `ask`, then `allow`.

- **Tool rules**: `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `NotebookEdit`, `Agent`, etc.
- **Path globs**: e.g. `Edit(src/**)` or `Read(/path/to/file)`. Both lexical and canonical (symlink-resolved) paths are checked.
- **Shell rules**: exact commands (`Bash(npm test)`) or safe command prefixes (`Bash(npm test:*)`). Shell prefix parsing rejects compound operators (`;`, `&&`, `||`, `|`), redirections, expansions (`$`, backticks), and newlines, and normalizes redundant `cd <cwd> && ...` prefixes.
- **Tool aliases**: native `pi` tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) map to `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`. `TaskRun` shares `Bash` policy, `AgentBatch` shares `Agent` policy, and `NotebookEdit` shares `Edit` policy.

### 2. Planning mode and user clarification

- **`EnterPlanMode`**: switches the session to read-only `plan` mode, remembers the previous mode, and designates a session-scoped plan file (`plan.md`). While in `plan` mode, source edits, shell tools, and `user_bash` are blocked; only workspace reads, read-only subagents, workflow tools, and edits to the designated plan file are allowed. Mode cannot be changed via `/permissions mode` until exited through `ExitPlanMode`.
- **`ExitPlanMode`**: displays the plan content and SHA-256 hash prefix for explicit UI approval. Verifies the plan file did not change during approval and restores the previous permission mode only if approved.
- **`AskUserQuestion`**: asks 1–4 structured single-select questions (each with 2–4 options plus a custom free-text option) via TUI/RPC UI. Fails explicitly in unattended/non-UI sessions.

### 3. Lifecycle hooks

Runs configured shell command hooks from `hooks.<Event>` in `.pi/settings.json` / `.pi/settings.local.json` (project hooks require project trust).

Supported events wired in this extension:

- `SessionStart` / `SessionEnd`
- `UserPromptSubmit` (can block prompts or append context)
- `PreToolUse` (can block tool calls; input rewrites on native tools are rejected)
- `PostToolUse` / `PostToolUseFailure` (can append additional context to tool results)
- `Stop` (can keep the agent working when a stop hook blocks settling)

Hooks receive a JSON payload on stdin and `CLAUDE_PROJECT_DIR` in their environment. Tool hooks support `*` or pipe-separated matchers (e.g. `Bash|Edit`) and configurable timeouts (default 30s, max 120s). Exit code `2` denies/blocks the operation; JSON stdout can return `decision`, `continue`, and `hookSpecificOutput` (`permissionDecision`, `additionalContext`).

### 4. Subagents

- **`Agent`**: launches an isolated child `pi` session with role `Explore`, `Plan`, or `general-purpose`, inheriting the parent model, thinking level, and permission policy.
  - `Explore` and `Plan` (and any subagent while in `plan` mode) receive read-only tools (`read`, `grep`, `find`, `ls`).
  - `general-purpose` (outside `plan` mode) receives `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`.
  - Recursive delegation is disabled. Child tool calls are evaluated against the parent policy, and approvals route through the parent UI.
  - Supports `resume` by saved agent UUID (keeping the original role), `max_turns` (default 20, max 100), and `timeout` (default 600s, max 3600s).
- **`AgentBatch`**: runs 1–8 independent subagent requests concurrently with a cap of 4 active children at once, preserving individual reports even when a sibling fails.

## Configuration

Settings are loaded from:

1. `~/.pi/settings.json`
2. `<workspace>/.pi/settings.json` (when project trust is granted)
3. `<workspace>/.pi/settings.local.json` (when project trust is granted)

Example `.pi/settings.json`:

```json
{
  "permissions": {
    "defaultMode": "safe",
    "allow": ["Bash(npm test:*)"],
    "ask": ["Write(src/**)"],
    "deny": ["Bash(rm -rf:*)"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/check-command.sh",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

## Installing from npm

The committed `.npmrc` routes `@pi-kode` packages to the public npm registry. The package is published publicly at [npmjs.com/settings/pi-kode/packages](https://www.npmjs.com/settings/pi-kode/packages) and requires no authentication to install:

```sh
npm install @pi-kode/permissions
```

Or install `@pi-kode/permissions` through `pi`'s package manager.

## Contributing & Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, running tests and type checks, architecture guidelines, and the release process.
