# DSH impact-analysis deep rules

These rules were carried forward from the older generic `codebase-impact-analysis` skill, with the tool surface rewritten for the DSH `dsh-codebase-memory` plugin.

Load this file only when one of these conditions applies:

- The analysis spans multiple indexed projects or sibling repositories.
- The target code is on a deployment, migration, upgrade, workflow, queue, or CloudEvent path.
- A frontend/generated API change needs a test-type verdict.
- You are about to conclude that a gap is covered because one consumer path has a guard.
- The target branch differs from the current DSH workspace branch.
- You need the completion checklist for a blast-radius report.

## Multi-project and external-project rules

DSH's `code_index` only indexes the current session workspace. Do not invent an indexing path for sibling repositories.

1. Identify relevant projects:
   - Use the current session workspace for the primary project.
   - Use `cbm_list_projects` for existing external indexes.
   - If the analysis mentions a frontend, backend, agent, package repo, or service boundary, treat it as a relevant project even if the user did not explicitly name it.

2. If a relevant external project is missing from `cbm_list_projects`:
   - Stop and state that the conclusion is partial because that project is not indexed.
   - Offer one of two human-controlled fixes:
     - open the missing repo as a DSH workspace and run `code_index` there;
     - run `codebase-memory-mcp cli index_repository --repo-path <human-approved-path>` from the terminal.

3. If a relevant external project is indexed but stale:
   - For that external project, ask the user to open the matching DSH workspace and run `code_index`, or request permission to use the CLI refresh path.
   - Do not rely on `auto_watch` alone in a multi-session host.

4. Every query must explicitly pass `project`. Cross-project analysis without `project` is unreliable.

Known ecosystem example: kapp-style deployments often span `kapp`, `kapp-web`, `kapp-agent`, and `packages`. The same shape applies to any multi-repo service: backend API, frontend client, async worker/agent, shared packages. The plugin should not hardcode repo names; it should discover and verify.

## Cross-branch and worktree rules

If the user asks about a branch other than the current workspace branch:

1. Detect the mismatch with `git branch --show-current` or by comparing the current branch to the target branch.

2. Prefer a DSH worktree/session over ad hoc temp indexing when the harness provides worktree tools. The current session's `code_index` only sees the current workspace.

3. If a temporary worktree is truly needed and the user has authorized it:
   - Create the worktree in a known path.
   - Index it only through a human-approved CLI command or by running a session whose workspace is that worktree.
   - Use `cbm_list_projects` to capture the returned project name.
   - Every subsequent cbm call must pass the worktree project explicitly.

4. Cleanup:
   - Remove the worktree only after analysis.
   - Do not automatically call `cbm_delete_project`; it is intentionally hidden from the model-facing surface.
   - If leaving a temp index is undesirable, ask the user whether they want to run `codebase-memory-mcp cli delete_project --project <name>` themselves.

## Protection coverage verification

When deciding whether a gap or vulnerability is mitigated, do not stop after one consumer has a guard.

1. Identify the function whose **output carries the gap**, not merely the function that normalizes its input.

2. Run:

   ```jsonc
   {"tool": "cbm_trace_path", "args": {"project": "<project>", "function_name": "<qualified-name>", "direction": "inbound", "depth": 3}}
   ```

3. Enumerate every consumer path. For each consumer, inspect whether it has the same guard, filter, validation, or feature gate.

4. If any consumer lacks the protection, the gap is not covered. Say so explicitly.

5. Trace the full failure chain to the end-user behavior layer:
   - backend failure point,
   - status field or state transition,
   - frontend UI gate,
   - API gate or deployment path gate,
   - async consumer or worker trigger,
   - final user-visible result.

   If the chain crosses repos and a downstream project is not indexed, mark the far side unverified.

Common failure mode: finding a diff filter in one caller, concluding "covered", and missing a second caller that passes the unsafe value through unchanged.

## Frontend and generated-code impact check

When a diff touches `web/gen/`, `frontend/gen/`, generated protobuf, OpenAPI clients, or generated RPC types:

1. Do not classify the change as "frontend impact" merely because a generated frontend path appears in the diff.

2. For each changed backend API name, search the frontend project:

   ```jsonc
   {"tool": "cbm_search_code", "args": {"project": "<frontend-project>", "pattern": "<API name>", "mode": "files"}}
   ```

3. Interpret results:
   - Hits only in generated directories: no direct UI caller, but still check async/deployment paths before saying "pure backend".
   - Hits in `src/components`, `src/services`, `src/hooks`, or app code: real frontend caller. Trace to the component and include it in the blast radius.
   - Zero hits: no direct frontend caller, but still check async/deployment paths before saying "pure backend".

4. The final report must give a per-API verdict:
   - pure backend, no frontend caller and no async flow impact,
   - frontend caller found with locator,
   - async/deployment flow impact with hop-by-hop locators.

## Async, deployment, and workflow impact check

Run this when any of these signals match a changed function:

1. The signature accepts a deploy, migrate, upgrade, stage, workflow, or job message.
2. The function is reached through a streaming RPC or long-running command handler.
3. The function is a Temporal, Cadence, background job, scheduler, or worker activity.
4. The function is invoked from a CloudEvent, queue consumer, webhook, or message handler.
5. The function reads or writes schema, datamodel, migration state, upgrade hash, deployment stage, or persisted extra values.

Any one signal is enough to run the full procedure.

### Direction rule

Start from the existing entry point and walk down to the changed function:

```text
frontend action -> API client -> API endpoint -> handler/service -> queue/event dispatch -> worker/activity -> changed function
```

Do not start at the changed function and conclude "no direct frontend callers, therefore no UI impact". Deployment-path functions are often downstream of a stable entry point and are expected to have no direct frontend caller.

### Procedure

1. Identify the entry point with `cbm_get_architecture`, `cbm_search_graph(label: "Route")`, or `cbm_search_code`.

2. Verify each hop:
   - In the backend project, trace the endpoint to the changed function.
   - In the frontend project, search the API name and trace the component.
   - In an agent/worker project, search the CloudEvent handler, queue consumer, or activity registration.

3. For each arrow, keep a verification status:

   ```text
   VERIFIED at <project>/<file>:<line>
   UNVERIFIED - inferred from naming, directory structure, or architecture knowledge
   ```

4. If `cbm_search_code` returns zero hits for a common API name and the project is fresh, re-check with a broader pattern. If still missing, the absence is evidence, not proof; state how you checked.

5. Before exiting the async check, answer these three questions for every function matched by a signal:
   - TRACE CHECK: Does each cross-project hop have a receiving-side locator, not just a caller-side edge?
   - ENTRY POINT CHECK: Did the trace start from the entry point and walk down to the changed function?
   - ASYNC CHAIN CHECK: Is every arrow backed by `cbm_trace_path`, `cbm_search_code`, or `cbm_get_code_snippet` evidence rather than inference?

### Verdict forms

Each changed function needs one of:

```text
<func>@<file:line> - async/deployment flow impact: <hop-by-hop chain>; UI testing applicable for <trigger scenario>
<func>@<file:line> - frontend caller found: <component>@<file:line>; UI testing applicable
<func>@<file:line> - pure backend modification; negative confirmations: no signal, no route/queue/event reference, no deploy/upgrade message type
```

Without all three negative confirmations, do not use "pure backend modification".

## Blast-radius completion gate

Before producing the report, tick every item:

- [ ] Every modified file is covered by at least one graph query or text search, or explicitly marked out of scope with a reason.
- [ ] Every behavioral claim has a `file:line` or `qualified_name` locator.
- [ ] Every cross-service hop either has a receiving-side locator or is labeled UNVERIFIED.
- [ ] Every "pure backend modification" verdict includes the three negative confirmations.
- [ ] Every "UI testing applicable" verdict names a concrete user trigger scenario and the component locator.
- [ ] Every implicit assumption is stated, decomposed, and verified by code where possible.
- [ ] Every conclusion has a falsification mode: "if wrong, the failure would manifest as <...>" and why that mode does not apply.

## Output discipline

Apply these rules to the first answer and every follow-up:

1. **Every behavioral claim needs a locator.** If you state that code fails, retries, filters, gates, reports status, or triggers an event, cite the code that does it.

2. **Cross-service edges are not far-side proof.** An `HTTP_CALLS`, `ASYNC_CALLS`, `EMITS`, or queue edge only proves the boundary is crossed. If you describe what the receiving side does, trace the receiver or mark it unverified.

3. **Follow-ups update the current conclusion.** Do not append "补充" that silently contradicts or completes the earlier answer. Restate the full conclusion when new findings change the risk verdict.

4. **Memory is output, not input.** Only persist conclusions verified against code or explicitly confirmed by the user. Never persist stale `file:line` locators, raw trace results, or risk verdicts as if they were durable truth.
