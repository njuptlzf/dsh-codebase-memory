---
name: dsh-cbm-investigate
description: Self-contained DSH cbm workflow combining root-cause debugging with codebase impact analysis. Use when debugging needs blast-radius checks, impact analysis finds a defect to fix, or design discussion needs graph-backed structure. Embeds a portable investigation core and queries cbm_* through mcp__cbm__mcp.
whenToUse: |
  Use when a task straddles bug investigation and structural cbm analysis:
  - "debug this, but check who else calls this function before changing it"
  - "trace this flow; if the logic is wrong, fix it"
  - "设计讨论 / 先看现状 / 分析影响范围后再决定改不改"
  Pure structural impact questions can use dsh-codebase-impact-analysis alone.
  A global investigate skill is optional; do not stop when it is absent.
---

# DSH cbm Investigate

This skill is a self-contained DSH workflow. It combines:

- a reduced, DSH-safe investigation core in `references/investigation-core.md`;
- `dsh-codebase-impact-analysis` for cbm graph queries, blast radius, freshness, and anti-degradation rules;
- optional global `investigate` when it is installed and the user explicitly wants that richer gstack-style process.

The plugin repo must remain usable on another DSH install without copying `investigate`. Therefore `investigate` is not a dependency. If `investigate` is missing, continue with this skill. If `investigate` is present, use it only as an optional extension, not as a gate.

## DSH tool surface

When this skill is active:

- Index current workspace code with `code_index`, not raw `index_repository`.
- Structural cbm queries use `mcp__cbm__mcp` with `cbm_*` tools.
- Source snippets use `cbm_get_code_snippet` with `format: "json"`.
- File coordinates used as edit anchors must be freshness-checked with `cbm_check_index_coverage`; when the worktree is dirty or coverage is not clean, re-read disk bytes before editing.
- External or sibling repositories are not auto-indexed by the model. If a needed project is missing, state partial scope and ask the user to open that workspace or approve CLI indexing.
- If cbm queries fail, run `code_setup`. Do not silently fall back to grep/read.

## Step 0 — preflight

1. Confirm the `dsh-codebase-memory` plugin chain.
   - If a structural query is needed, run `code_index` first.
   - If `code_index` or `mcp__cbm__mcp` fails, run `code_setup` and report the concrete failure.

2. Load `dsh-codebase-impact-analysis` before structural code queries.
   - This skill owns routing.
   - `dsh-codebase-impact-analysis` owns the cbm tool table, freshness gate, blast-radius workflow, rename workflow, flow tracing, and deep rules.

3. Choose the investigation process:
   - Default: use this skill's `references/investigation-core.md`.
   - Optional: if a global `investigate` skill exists and the user explicitly asks for it, load it and follow its process.
   - If global `investigate` is absent, do not stop. Continue with `references/investigation-core.md`.

## Entry A — symptom-driven debugging with impact awareness

Use when the user starts with a bug but the fix should not land without blast-radius awareness.

1. Run root-cause investigation using `references/investigation-core.md` Phase 1 to Phase 3, but delegate all structured code queries to `dsh-codebase-impact-analysis`:
   - Definition lookup: `cbm_search_graph`, not raw grep.
   - Source reading: `cbm_get_code_snippet(format:"json")`, not full-file `read` unless context beyond the symbol is needed.
   - Caller/callee lookup: `cbm_trace_path`, not grep for function names.
   - Text/config/dynamic references: `cbm_search_code`, with at least one search not restricted to a single file type when hunting configuration values.

2. **Anti-anchoring check.** Before committing to a single potential cause, ask whether the value was already wrong before it reached that point. Trace the value lifecycle with three questions:
   - Definition: where is the value produced? Check `.go`, `.sql`, `.yaml`, `.yml`, templates, `{{.}}`, config, and generated files when relevant.
   - Transformation: what renders, merges, filters, overrides, or persists it along the way? Note priority order.
   - Re-generation: is there a later render or rebuild step that overwrites the saved value with a definition-time default?

   If the definition or a later regeneration already produces the wrong value, the downstream suspect may not be the root cause.

3. **Early impact gate.** If you are about to dismiss a gap because one consumer path has a guard, run impact analysis before accepting that conclusion:
   - Find the function whose output carries the gap.
   - Run `cbm_trace_path(direction: "inbound")` on that function.
   - Check every consumer path.
   - If any consumer lacks the guard, the gap is real.

4. Before implementation, run `dsh-codebase-impact-analysis` Workflow 1 on the functions the fix will touch:
   - `cbm_search_graph` resolves the target.
   - `cbm_trace_path(direction: "inbound", depth: 3)` at minimum.
   - Widen to depth 5 or add `direction: "outbound"` when contracts or fan-out change.
   - Add architecture/route/cross-service checks when an HTTP, gRPC, queue, workflow, or CloudEvent boundary is involved.

5. Feed the blast-radius result into the investigation core's >5-file gate. If the graph already shows a wide or cross-service radius, surface it up front.

6. Hand off to `references/investigation-core.md` Phase 4 and Phase 5, or to the optional global `investigate` if it was loaded. Use graph-backed queries for any further code lookup.

## Entry B — structure-driven analysis that finds a defect

Use when impact analysis or flow tracing unexpectedly reveals an actual defect.

1. Load and run `dsh-codebase-impact-analysis` Workflow 1 or 3.
   - Every structural claim needs a locator.
   - Cross-service edges alone are not far-side proof.
   - If the chain crosses repos, verify each project or mark the missing side unverified.

2. If the result is only "risky to change", stop with the impact report. Do not force a debugging workflow.

3. If the result shows a concrete defect, ask the user whether to fix it now.

4. If the user confirms a fix, skip root-cause Phase 1 to Phase 3. The root cause is already established by code structure. State the finding in the standard form:

   ```text
   Root cause hypothesis: [defect] — [project/file:line]
   ```

5. Hand off directly to the investigation core Phase 4 and Phase 5, or to optional global `investigate` if present and requested.

## Entry C — design discussion or structural exploration

Use when the user wants code-graph understanding before deciding whether to change anything.

1. Run `dsh-codebase-impact-analysis`:
   - locate symbols with `cbm_search_graph`,
   - map relationships with `cbm_trace_path`,
   - summarize entry points or modules with `cbm_get_architecture`,
   - pull key source with `cbm_get_code_snippet(format:"json")`.

2. Present the structural result. This entry is read-only by default. Do not patch code and do not start the investigation implementation phases unless the user explicitly asks.

3. After presenting findings, ask whether the user wants to proceed to changes:
   - If yes, hand off to the investigation core Phase 4 and Phase 5, or optional global `investigate` if available.
   - If the user only wanted understanding, stop.
   - If they want a different trace, loop back to step 1 with the new target.

## Optional global investigate

If the host has a richer global `investigate` skill and the user wants that workflow:

- Load it only after this skill's DSH tool surface is clear.
- Let it own Phase 1 to Phase 5, telemetry, voice, scope lock, hooks, or project-specific review behavior if those exist.
- Override only its structured code queries: definitions, callers, blast radius, flow tracing, and graph-backed impact must follow `dsh-codebase-impact-analysis`.
- Do not hard-depend on it. Do not treat it as absent-proof.

The default path is `references/investigation-core.md`, so another user who installs this plugin still gets a usable debugging + cbm workflow.
