# Contributing to @pi-kode/permissions

Thank you for contributing to `@pi-kode/permissions`. This guide covers local development, testing, code conventions, and releasing.

## Prerequisites

- **Node.js 22+** (the test runner uses `node --experimental-strip-types --test`; the release workflow runs on Node 24)
- **npm**

## Setup

Clone the repository and install dependencies without generating a lockfile (this repository does not commit `package-lock.json`):

```sh
git clone https://github.com/pi-kode/permissions.git
cd permissions
npm install --no-package-lock
```

## Project structure

```text
index.ts                         Package entrypoint exporting the extension installer
lib/src/
  features/permissions.ts        Main extension wiring (/permissions command, tool_call, tool_result, input, session hooks)
  extensions/
    policy.ts                    Mode and allow/ask/deny rule evaluation, glob and shell prefix matching
    planning.ts                  EnterPlanMode, ExitPlanMode, AskUserQuestion, and plan-mode guards
    hooks.ts                     Command hook runner and Stop hook integration
    agents.ts                    Agent and AgentBatch child-session runner
  runtime/
    governance.ts                GovernanceRuntime, session state persistence, tool registration
    config.ts                    .pi/settings.json and .pi/settings.local.json loader
    approvals.ts                 Serialized UI approval queue
    events.ts                    Hook event and outcome types
    schema.ts                    TypeBox schema helpers
    utils.ts                     Hashing, canonical paths, atomic writes, formatting
  backends/
    process.ts                   Subprocess runner used by lifecycle hooks
tests/
  helper.ts                      In-memory ExtensionAPI / ExtensionContext test harness
  policy.test.ts                 Policy, modes, shell parsing, approvals, and config tests
  agents.test.ts                 Subagent concurrency, allowlist, resume, and SDK binding tests
.github/workflows/publish.yaml   Tag-triggered npm publish workflow
```

## Development workflow

There is no separate build step; TypeScript sources are executed directly via Node type stripping and `pi`'s extension loader.

Run typechecking and tests:

```sh
npm run typecheck
npm test
```

Run a single test file while iterating:

```sh
node --experimental-strip-types --test tests/policy.test.ts
```

To test the extension locally in `pi`, point `pi` to this checkout directory as a local extension/package path.

## Coding and testing guidelines

- **TypeScript**: Strict mode is enabled in `tsconfig.json`. Use ESM syntax with explicit `.ts` extensions on relative imports (`allowImportingTsExtensions: true`).
- **Compatibility**: Preserve existing persisted state and event identifiers (`code-compat:state`, `pk:permission-grant`, `pk:permission-rule`, `pi-ko:governance:v1`) and `.pi/settings*.json` configuration paths unless a breaking change is explicitly intended.
- **Security**: Keep permission checks fail-closed. Preserve TOCTOU re-validation after UI prompts, symlink canonicalization in path rules, and strict shell tokenization in `Bash(...)` rules.
- **Tests**: Add or update unit tests in `tests/` using `node:test`, `node:assert/strict`, and `tests/helper.ts`.
- **Verification**: Ensure both `npm run typecheck` and `npm test` pass with zero errors before opening a pull request.

## Releasing & publishing

Packages are published to the `@pi-kode` npm organization (`https://www.npmjs.com/settings/pi-kode/packages`) automatically by `.github/workflows/publish.yaml` using **npm OIDC Trusted Publishing** (no `NPM_TOKEN` secret required).

Publishing is triggered **only** when a tag matching `vX.X.X-release` (for example `v0.7.1-release`) is pushed to GitHub.

### Release steps

1. Bump `"version"` in `package.json`, e.g. `0.7.1`, and merge the version bump into `main`.
2. Create and push an annotated tag matching `v<version>-release`:

   ```sh
   git tag -a v0.7.1-release -m "Release v0.7.1"
   git push origin v0.7.1-release
   ```

3. The `Publish` workflow runs the `verify` job to validate that:
   - the tag strictly matches `^v[0-9]+\.[0-9]+\.[0-9]+-release$`,
   - the tag version matches `package.json` `"version"`,
   - the package name is scoped under `@pi-kode/`,
   - `npm test` and `npm run typecheck` pass.
4. Once `verify` passes, the `publish` job pauses at the `npm-publish` GitHub Actions environment. Open the workflow run in GitHub Actions and click **Review deployments** → **Approve and deploy** to run `npm publish --provenance --access public`.

### One-time release setup (maintainers)

1. **GitHub Actions environment** (in repository **Settings → Environments**):
   - Create an environment named `npm-publish`.
   - Enable **Required reviewers** and add the maintainer(s) authorized to approve releases.
2. **npm Trusted Publishing** (in package settings for `@pi-kode/permissions` under `https://www.npmjs.com/settings/pi-kode/packages`):
   - **Organization / user**: `pi-kode`
   - **Repository**: `permissions`
   - **Workflow filename**: `publish.yaml`
   - **Environment**: `npm-publish`
