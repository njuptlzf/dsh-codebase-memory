# DSH investigation core

This is a portable, DSH-safe reduction of the classic `investigate` workflow. It deliberately omits gstack telemetry, voice, external scripts, hooks, CLAUDE.md bootstrap, and project-local tools. Those can be added by an optional global `investigate` skill, but this core is enough for debugging code in DSH.

## Iron law

```text
No fix without root cause investigation first.
```

Symptom patches create whack-a-mole debugging. Find the mechanism, then fix the smallest real cause.

## Core rules

- Never say "this should fix it." Verify by running reproduction or tests.
- Never apply a fix you cannot verify.
- If three hypotheses fail, stop and ask the user how to proceed.
- Prefer the complete correct fix over a shortcut when the cost is small.
- Keep the diff minimal to the root cause; do not opportunistically refactor unrelated code.
- If the bug looks architectural, stop and escalate rather than patching layers repeatedly.

## Phase 1 — root cause investigation

Collect evidence before hypothesizing.

1. **Collect symptoms.**
   - Error messages, stack traces, logs, reproduction steps, environment, recent commits.
   - If context is missing, ask one focused question at a time.

2. **Read the code path.**
   - Trace backward from the symptom to the likely data or control-flow origin.
   - Use `dsh-codebase-impact-analysis` for graph-backed queries:
     - `cbm_search_graph` for definitions and qualified names,
     - `cbm_get_code_snippet(format:"json")` for symbol source,
     - `cbm_trace_path` for callers/callees,
     - `cbm_search_code` for literals, configs, templates, and dynamic references.

3. **Check changes.**
   - Was this working before?
   - What changed recently?
   - If it is a regression, inspect the diff before guessing.

4. **Reproduce deterministically if possible.**
   - If you cannot reproduce it, gather more evidence before proposing a fix.

5. **Form a hypothesis.**
   - Output:

   ```text
   Root cause hypothesis: [specific defect] — [project/file:line or qualified_name]
   ```

6. **Anti-anchoring check.**
   Before committing to a suspect, ask whether the value was already wrong before it reached that point:
   - Definition: where is it produced?
   - Transformation: what renders, merges, filters, overrides, or persists it?
   - Re-generation: does a later step overwrite the saved value with a default?

7. **Early impact gate.**
   If one consumer has a guard, do not conclude coverage. Trace the function whose output carries the gap and check every consumer path.

## Phase 2 — pattern analysis

Check whether the failure matches a known shape:

| Pattern | Signature | Where to look |
|---|---|---|
| Race condition | intermittent, timing-dependent | shared state, callbacks, async workers |
| Null propagation | TypeError, no method, undefined | missing guards on optional values |
| State corruption | partial updates, inconsistent fields | transactions, caches, reducers, persisted state |
| Integration failure | timeout, unexpected response | HTTP/gRPC clients, queues, webhooks, external APIs |
| Configuration drift | works locally, fails elsewhere | env vars, feature flags, DB state, deployment values |
| Stale cache | fixes after cache clear | browser, CDN, Redis, memoization |
| Generated-code drift | manual change disappears | codegen inputs, build steps, checked-in generated files |
| Index/line-coordinate drift | source looks neighboring or stale | cbm freshness, `code_index`, `cbm_check_index_coverage` |

If web search is available and the error is safe to share, search the sanitized error category and framework context. If the raw error contains secrets, paths, customer data, SQL, or internal identifiers, strip them first or skip search.

## Phase 3 — hypothesis testing

Before writing a fix:

1. **Confirm the hypothesis.**
   Add the smallest possible temporary evidence: log line, assertion, focused test, debug query. Run the reproduction. Does the observed behavior match the claim?

2. **If wrong, gather more evidence.**
   Return to Phase 1. Do not stack guesses. Consider searching prior code history or existing tests before another hypothesis.

3. **3-strike rule.**
   If three hypotheses fail, stop and ask the user:

   ```text
   Three hypotheses were tested and none matched.
   A) Continue with a new hypothesis
   B) Escalate for human review
   C) Instrument the area and collect more evidence
   ```

Red flags:

- "Quick fix for now."
- A fix proposed before tracing data flow.
- Each attempted fix reveals another nearby issue.
- You cannot explain the mechanism well enough to verify it.

## Phase 4 — implementation

Once the root cause is confirmed:

1. Fix the cause, not the symptom.
2. Keep the diff minimal.
3. Add or update a regression test when possible.
   - It must fail before the fix.
   - It must pass after the fix.
4. Run the relevant test suite or smallest meaningful verification command.
5. If the fix touches more than five files, ask before proceeding:

   ```text
   This fix touches N files, which is a large blast radius for a bug fix.
   A) Proceed — the root cause genuinely spans these files
   B) Split — fix the critical path now and defer the rest
   C) Rethink — find a more targeted root-cause approach
   ```

In DSH, run `code_index` after substantial edits if later graph analysis or line anchors matter.

## Phase 5 — verification and report

Fresh verification is required:

- Reproduce the original failing scenario and confirm it no longer fails.
- Run the test suite or verification command and paste the relevant output.
- State what could not be verified, if anything.

Report shape:

```text
DEBUG REPORT
════════════════════════════════════════
Symptom:         [what the user observed]
Root cause:      [what was actually wrong]
Fix:             [what changed, with file:line references]
Evidence:        [test output or reproduction result]
Regression test: [file:line of the new test, if any]
Related:         [prior bugs, affected flows, unresolved concerns]
Status:          DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
════════════════════════════════════════
```

## Completion statuses

- **DONE:** root cause found, fix applied, regression/verification passed.
- **DONE_WITH_CONCERNS:** fixed but full verification is impossible, intermittent, or staging-only.
- **BLOCKED:** cannot proceed safely; state blocker and what was tried.
- **NEEDS_CONTEXT:** missing user/domain/environment information; state exactly what is needed.

Escalation is allowed and preferred over false confidence.

## DSH-specific guardrails

- If using cbm results as `file:line` edit anchors, first verify freshness:
  ```jsonc
  {"tool":"cbm_check_index_coverage","args":{"project":"<project>","paths":["relative/path"]}}
  ```
  If stale or dirty, run `code_index` and use `read` for disk bytes.
- If cbm cannot run, do not silently switch to grep/read. Ask for fallback or state:

  ```text
  [工具路径] DSH grep/read fallback；原因：code_index/code_setup 报告 cbm 链路未就绪。
  ```

- If impact analysis crosses service or repo boundaries, either trace the receiving side or mark the far-side behavior unverified.
