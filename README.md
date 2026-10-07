# agent-qa

Interactive local pre-merge QA for JavaScript/TypeScript projects:

**Select repo → enter URL and intent → analyse/explore → generate tests → approve and run → report.**

The default requires four responses: repository path, localhost URL, intent, and execution approval. Supply the first three as flags to leave only execution approval.

Codex uses your local ChatGPT sign-in for sequential QA planning, browser exploration through Playwright MCP, test generation, in three AI stages. Repeatable browser tests run through Playwright Test. `--deep` adds detailed scenario review, existing-runner unit/integration coverage, independent AI test review, and finding assessment/classification.

## Install

Requires macOS, Node 22.18+, Git, Codex CLI, and an existing ChatGPT sign-in. The invocation flags have been tested with Codex 0.160.0. Playwright MCP is pinned to 0.0.83.

```sh
npm install
npx playwright install chromium
codex login status
npm run build
npm run qa
```

Start your app yourself and prepare repeatable development/test data before checking it. The default displays and records assumed prerequisites: the supplied localhost server represents the selected source and development data is repeatable/resettable. Deep sessions ask for developer confirmation. Browser profiles and fresh test contexts isolate browser data; they do not reset backend state or isolate the operating system. Authentication flows are outside the guided workflow's scope.

## Guided check

`agent-qa` and `agent-qa check` start the same guided flow. With this checkout, use `npm run qa` or `node dist/cli.js`.

```sh
npm run qa -- check --repo /path/to/app --base main \
  --url http://localhost:3000/settings \
  --intent "Save stays disabled until a setting changes" \
  --criteria "Save is initially disabled" \
  --criteria "Editing Setting enables Save" \
  --change-type feature
```

Supplied flags bypass their prompts. Intent becomes AC1 unless explicit criteria are supplied; change type defaults to feature. Available flags:

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | Required repository selection; prompted when missing, with no current-directory fallback. |
| `--base <ref>` | Base branch/ref; no automatic fetch. |
| `--url <URL>` | HTTP(S) loopback URL without embedded credentials. |
| `--intent <text>` | Feature or bug-fix description. |
| `--criteria <text>` | Repeatable explicit acceptance criteria; overrides the default 1–3 browser scenario target. |
| `--change-type feature\|bug-fix` | Type of change. |
| `--include-local` | Compatible explicit selection of local work, included by default. |
| `--committed-only` | Exclude staged, unstaged, and untracked work; conflicts with `--include-local`. |
| `--deep` | Detailed scenario review, existing-runner unit/integration tests, independent review, and finding classification. |
| `--context <file>` | Repeatable supporting context from the selected revision. |
| `--timeout <milliseconds>` | Per AI stage/test group limit, default 600000; range 1000–3600000. |
| `--model <name>` | Explicit Codex model override for guided stages; default is `gpt-5.6-luna` with `medium` reasoning (`xhigh` for deep sessions). |
| `--headless` | Hide exploration Chromium; default is visible. Replay remains headless. |
| `--session <id>` | Reopen a saved session. |

The checked-out target branch is reviewed without switching branches. Comparison uses the merge base with the first available reference: explicit `--base`, recorded `origin/HEAD`, `main`, `origin/main`, `master`, `origin/master`. Only an absence of references requires a prompt. No reviewable changes produces an actionable error; scope is never silently replaced.

The branch summary labels the target branch and comparison reference separately and shows head/merge-base SHAs, commit subjects/bodies, changed paths, detected runners, omitted context, and the AI analysis. Commit/intent conflicts require recorded developer clarification.

By default the displayed plan automatically selects scenarios, separately from developer approval. It targets 1–3 browser scenarios around changed behavior and the most relevant regression, with explicit criteria overriding that target. Changes without browser-verifiable behavior are reported as a limitation with a suggestion to use `--deep`.

With `--deep`, review scenarios with `approve`, `edit`, `add`, or `exclude`. Exclusion requires a reason. Scenarios map to stable acceptance IDs such as `AC1` and stable scenario IDs such as `S1`. Exploration exercises only approved flows, using snapshots at each state, including dialogs, navigation, and dynamically rendered controls. Progress prints browser tool activity; successful and failed interactions retain screenshots and action evidence.

The default displays scope, assumed prerequisites, complete generated source, hashes, and required support before one prompt: **Run all / inspect / edit / regenerate / cancel**. `Run all` approves the exact displayed files and execution, then runs immediately. Results and reports are saved automatically; there are no mandatory classification, gap-exclusion, finish, or export prompts. Failed checks and incomplete selected coverage cannot become passing.

With `--deep`, review generated tests with `source`, `edit`, `regenerate`, `approve`, or `reject`. Enter test IDs to approve a subset, or explicitly enter `all`. Required support files are included in that approval. Edits use `VISUAL` or `EDITOR`; configure an editor that waits for completion, for example `EDITOR='code --wait'`. Without an editor, the CLI prints a new revision path for you to edit and save. Every edit or regeneration creates a new retained revision, requiring fresh approval; deep sessions also perform independent review. Files changed after approval block execution.

Each generated revision writes its tests and required support files separately under the session folder at `revision-*/tests/`. Selecting `finish` saves the final report and ends the guided flow; copying tests into the target repository remains an explicit `export` command.

Deep results retain original observations. Classify each finding as `bug`, `intended`, `invalid`, or `unresolved`, with a reason. Classification adds feedback and never changes the executed files or erases a failed run. `revise-tests`, `revise-plan`, and `rerun` require another review/approval. Reported gaps can be explicitly excluded from accepted scope with a recorded reason; uncovered approved scenarios still prevent a passing outcome.

## Reopen and export

```sh
npm run qa -- review --session session-2026-10-04T08-00-00-000Z-example --timeout 600000
npm run qa -- export --session session-2026-10-04T08-00-00-000Z-example
```

Use the actual printed session ID. `review` resumes the saved stage; pass `--timeout` to override its saved per-stage limit. `review --session` offers optional result follow-up, including revisions and reruns. Legacy sessions retain their detailed behavior and saved source scope; new sessions persist depth and local selection. Enter `cancel`/`quit`, press Ctrl-C, or close input to retain partial results. An interrupted execution is not automatically trusted as passing; resuming requires explicit execution confirmation. A timed-out exploration retains logs/evidence and records incomplete scenarios. Reopening continues with the saved source selection; start a new session to select another revision.

Export explicitly selected approved tests and their required test-only support. The CLI shows destinations and file contents/diffs before asking for approval. Existing destinations require another path. Exclusive creation prevents overwriting a file that appears during export. If you relocate files, keep relative imports valid. Export never commits or merges anything.

## Source and execution boundaries

The guided workflow defaults to **the checked-out branch plus staged edits, unstaged edits, and eligible untracked source versus the merge base**. The existing snapshot mechanism freezes selected local source for later execution. `--committed-only` reads committed HEAD and excludes local work. Known secret/environment files, generated output, dependencies, binary data, unsafe paths, and symlinks are excluded from model context. The 100000-byte context limit remains; reports list omitted files and gaps. Review source before submission: filename exclusions cannot detect secrets embedded in ordinary source.

Unit/integration execution extracts a disposable Git source snapshot matching the selected revision. Installed dependencies are reused only when dependency declarations and lockfiles match. Packages are linked individually so ordinary runner caches remain in the snapshot. Existing tests run before generated tests/support files are added, making pre-existing failures distinguishable. Missing dependencies, compiled output, fixtures, services, unsupported symlinks, or incompatible runner setups block execution. The CLI does not install application dependencies or guess build/server commands. Complex monorepo/build-specific setups may require adapting reviewed tests or preparing their prerequisites.

Browser replay uses the tool's own configuration, fresh contexts, Chromium, one worker, no retries, and screenshots/traces for successful and failed tests. Specs are ordinary Playwright files with semantic locators and behavior assertions. The guided workflow has no fixed three-test ceiling. Browser-only and unit-only coverage are accounted for separately. Generated skipped/focused/expected-failure checks are rejected.

AI stages use `gpt-5.6-luna` with `medium` reasoning by default (`xhigh` for deep sessions), an empty workspace, a read-only Codex shell sandbox, disabled shell tools, and a per-invocation browser-tool allowlist. Global Codex settings are not changed. Arbitrary browser code evaluation is omitted from that allowlist. The configured browser origin reduces accidental external navigation but is not an OS security boundary. App source, diffs, intent, browser snapshots, and selected evidence go to the Codex model service using your existing sign-in. Credentials are not read or stored by this tool; inherited API-key environment variables are removed. Generated tests execute as **trusted reviewed local code** with your local user permissions.

## Reports and checks

Each guided session lives under the tool checkout's ignored `.agent-qa/session-*/` directory:

- `session.json` and `report.json`: version 2 records linking source, scenarios, exploration, test revisions, execution IDs/file hashes, findings, feedback, and exports.
- `report.md`: readable scope, source assumptions, coverage, omitted context, evidence, findings, and feedback.
- `analysis-*`, `exploration-*`, revision directories: prompts, strict schemas, model responses, invocation metadata, stdout/stderr, independent reviews, screenshots, MCP action logs and raw traces.
- `execution-*`: exact selected specs/support, disposable source snapshots, execution records, logs, runner JSON, Playwright screenshots and trace ZIPs.

Exit codes: **0** completed passing accepted scope; **1** failed checks; **2** blocked, invalid, cancelled, or incomplete scope. An intended/invalid classification does not turn the original failure into a pass. Suggested causes and fixes are separated from observations; source citations are retained only for supplied files.

```sh
npm test                     # Git selection, contracts, review/cancel, export, process checks
# Fixture-only dependencies, installed under ignored artifacts:
npm install --prefix .agent-qa/fixture-dependencies --ignore-scripts vitest@4.1.0 jest@30.2.0
npm run test:runners          # Node/Vitest/Jest baselines, generation replay and regression
npm run test:live             # Real fluid flow, prompt/stage/time metrics, replay and regression
AGENT_QA_DEEP=1 npm run test:live # Optional deep workflow and export
AGENT_QA_LIVE=1 npm run test:runners  # Also generate runner fixtures through signed-in Codex
npx playwright show-trace /absolute/path/to/trace.zip
```

Live checks need process/network permissions and use your signed-in Codex account. The fixtures have no authentication/backend services. Reports and traces can contain source, application text, and sensitive browser data; keep `.agent-qa/` private.

## Code organization

The CLI delegates to `src/workflow.ts`, which coordinates the persisted QA stages.
Modules separate shared data definitions from the operations that use them:

| Module | Responsibility |
| --- | --- |
| `session-types.ts` | Serializable scenarios, generated tests, exploration, executions, findings, feedback, and session state. |
| `context-types.ts` | Git changes, source context, branch metadata, and detected test runners. |
| `session.ts` | Session persistence, feedback history, coverage accounting, reports, and artifact path validation. |
| `context.ts` / `branch.ts` | Safe source reads, Git inspection, runner detection, and source snapshots. |
| `schemas.ts` | Structured AI response schemas and strict recursive validation. |
| `stages.ts` | AI analysis, browser exploration, test generation, and independent review. |
| `interactive.ts` | Terminal prompts, scenario/test/finding review, editing, and export. |
| `execution.ts` | Approved-file validation, runner invocation, baselines, and execution persistence. |
| `runner-results.ts` | Pure runner-result classification, per-file outcomes, and failure summaries. |
| `codex.ts` / `process.ts` | Codex configuration and subprocess lifecycle management. |
| `setup.ts` / `node-reporter.ts` | Playwright preflight and native Node test event reporting. |

Import shared types from the type modules and AI schemas from `schemas.ts` for new code.
The original modules re-export their existing public types, schemas, and result helpers
so existing imports remain valid. Keep model field documentation alongside its type;
keep operational documentation alongside the function that implements it.

## References and attribution

Browser integration follows [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Playwright Test traces](https://playwright.dev/docs/trace-viewer), and [Codex per-server tool selection](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Native Node reporter events retain per-file outcomes and assertion evidence. Existing runner invocations follow the [Vitest CLI](https://vitest.dev/guide/cli), [Jest CLI](https://jestjs.io/docs/cli), and [Node test runner](https://nodejs.org/api/test.html).

The sequential stage responsibilities in `roles/` adapt VoltAgent's MIT-licensed [awesome-codex-subagents](https://github.com/VoltAgent/awesome-codex-subagents) definitions for `qa-expert`, `browser-debugger`, `test-automator`, `reviewer`, and scoped `ui-ux-tester` guidance. Their model choices, permissions, and browser endpoint are not copied. The upstream license is retained in `roles/LICENSE`.
