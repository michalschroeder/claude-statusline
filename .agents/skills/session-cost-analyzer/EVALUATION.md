# Session evaluation rubric

How to rate a Claude Code session 1–5 and write its assessment cards. Distilled from
Anthropic's cost / context-engineering docs and the June 2026 community playbooks. This is the
self-contained rubric the assessment subagent reads before grading.

**Scope.** This rubric judges *how efficiently a session was driven* — context discipline,
scoping, delegation, model choice, planning. It deliberately ignores plan selection and
billing (Pro vs Max vs API, per-day dollar benchmarks, the autonomous-credit split): those are
purchasing decisions, and a session's grade must not depend on which plan paid for it. Grade
the habits, not the invoice.

---

## 1. The cost mechanism (the "why" engine)

A session's cost ≈ **context size × number of steps**. Claude re-reads the *entire* live
context on every turn — system prompt, CLAUDE.md, tool definitions, every file read, every
command output, every prior reply — so cost is dominated by re-reading a window that only
grows. Internalize these mechanics; the WHY on every card should trace back to one of them:

- **Prompt caching is the master lever, and it's fragile.** Unchanged prefixes are served from
  cache at **0.1× input price** (a cache *read*); a cache *write* costs 1.25× input (5-min TTL)
  or 2× (1-hour). So a stable, re-read prefix is cheap — until something busts it. Cache
  invalidators: switching model mid-session (`/model`, the opusplan toggle), changing `/effort`,
  editing CLAUDE.md, or any changing prefix (e.g. a timestamp). Idling past the TTL forces a
  full re-write. After an invalidation the whole window is re-billed at input price, not 0.1×.
- **`cache_creation` vs `cache_read` is the health signal.** Healthy long sessions are almost
  all cache-read; high, repeated cache-creation means the prefix keeps changing (model/effort
  switch, CLAUDE.md edit) and is silently inflating the bill.
- **Every step is another full re-read.** A turn that triggers 30 tool rounds pays the context
  cost ~30 times. Fewer, fatter steps (batched independent commands) beat many thin ones.
- **Extended thinking bills as output (~5× input)**, on by default with a large budget.
  *Interleaved/unstored* thinking fires before each tool call and is never written to the
  transcript, so it scales with **step count** — a 150-step session pays the thinking tax 150
  times, even on mechanical Writes/Bash. Reasoning on nearly every step is a top silent cost
  sink; the `assistantOutput.thinking` stored-vs-unstored split and `byTurn` show how much, and
  where.
- **Context rot is real but a gradient, not a cliff.** Model accuracy declines as the window
  fills (Anthropic confirms this, citing Chroma's 18-model study). Treat ~80% of the window as
  a soft cap for heavy multi-file work and keep the last ~20% for light wrap-up. Community
  anecdotes of quality clipping around 60% capacity / ~150k tokens are rough heuristics, not
  measured thresholds — directionally useful, don't quote as fact.

The implication that drives the whole grade: **keep the context small** (compact / clear /
scope) and **take fewer steps** (batch, plan, delegate). A flashy detail — a terse "do it"
prompt, one expensive skill — is usually *where* spend landed, not *why*; the same prompt costs
about the same in any large window, because you paid to re-read the window, not to read the words.

---

## 2. The levers (mechanism + magnitude)

Use these both to grade and to write the HOW on cards. Magnitudes are the reported figures;
hedge them in cards ("~30–40%", "community-reported") rather than stating as gospel.

**Context discipline**
- **`/compact [focus]`** summarizes history and continues, reusing the cached prefix (the
  summarization call is cheap). Best run *after* finishing a phase, at a natural boundary — not
  mid-debug (it collapses the stack traces you still need) and not after quality already dropped.
- **`/clear`** wipes history to zero between *unrelated* tasks. Anthropic's #1 named failure mode
  is the "kitchen-sink session." Heuristic: if the next task doesn't depend on the last ~20
  messages, `/clear`. The **"after two corrections, clear"** rule: re-correcting the same issue
  >2× means context is cluttered with dead approaches — a fresh session + sharper prompt almost
  always beats grinding on.
- **`/context`, `/usage`, `/rewind`**, PreCompact hooks, status-line thresholds — proactive
  monitoring and earlier auto-compaction (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`).
- **Hooks that pre-filter tool output** (e.g. grep test logs for failures) cut a result from
  tens of thousands of tokens to hundreds.

**Thinking control**
- Extended thinking is on by default with a large budget. Lower it the moment the plan is
  settled: **`/effort low`** (granular, persists for the session — still reasons on genuinely
  hard steps, drops it on rote ones) or the **`Alt+T` / `Option+T`** toggle (binary on/off,
  session-wide). `ultrathink` in a prompt only *raises* it for one turn; there is no inverse
  word, and `MAX_THINKING_TOKENS` needs a restart. Prefer these live levers over editing `/config`.
- Interleaved thinking is one-think-per-tool-call, so **fewer steps also cut it** — batching
  tool calls saves reasoning and cache re-read together.
- Estimating the saving: base it on `assistantOutput.thinking.byTurn` (per-turn intensity), not
  the flat per-step average, and frame `/effort low` as a *reduction* (~50–70%), not full
  elimination — it lowers thinking, it doesn't switch it off.

**Scoping & multi-session**
- One coherent task per session; don't run a single session all day. Split a big epic into
  phases (research → design → implement → harden), each its own session.
- **Handoff notes**: before clearing/compacting, have Claude write decisions + key files +
  remaining TODOs to a markdown file and re-load it next session, instead of dragging 100k
  tokens of history forward. Counterintuitively, three scoped 40k sessions often beat one 180k
  session — less per-turn re-read, better locality, independent compaction.
- **Spec-first for big features**: interview → write SPEC.md → fresh session to implement.
  Precision in the spec pays off more than watching the implementation.
- **Review in a fresh session.** Code review and cleanup (`/code-review`, `/simplify`) belong in
  a *separate* session from the one that wrote the code. Both pull their own diff from git, so
  they need none of the implementation history. Running them inline re-reads the whole bloated
  implementation window on every review step, and a reviewer primed by the author's own reasoning
  rationalizes choices instead of challenging them. Implement → commit → `/clear` (or fresh
  session) → review. (Even inline, the finder subagents get clean windows; it's the orchestrator's
  synthesis that stays contaminated.)

**Delegation (subagents) — "one of the most powerful tools"**
- A subagent reads many files in *its own* window and returns only a summary, so bulk never
  lands in the main context. Use for investigation, log triage, test runs, bulk edits.
- Cost note: agents use ~4× the tokens of a chat turn, and multi-agent fan-out ~15×; agent
  *teams* in plan mode ~7× a standard session. So fan-out is for breadth-first, parallelizable,
  high-value work — **not** tightly-coupled coding. Prefer subagents over teams when a task is
  self-contained; cap concurrency; ban recursive spawning.

**Model routing**
- Default **Sonnet** for ~80–90% of work (SWE-bench ~79.6% vs Opus ~80.8% — the gap is ~1pt
  while Opus costs ~5× the output). Escalate to **Opus** only for genuinely hard multi-file
  architecture / debugging. Route mechanical subagents to **Haiku**. Opus on rote work, or a
  mid-session model swap that busts the cache, are both gradeable waste.

**Planning & prompts**
- **Plan mode** (Explore → Plan → Code → Commit) separates research from execution and prevents
  expensive wrong-direction rework — community-measured at ~30–40% token savings on complex
  tasks. Skip it only for one-sentence diffs (typo, rename, one log line).
- **Specific prompts beat vague ones**: "add input validation to the login function in auth.ts"
  reads a few files; "improve this codebase" triggers a broad, expensive scan. Always give
  verification targets (tests, expected output) so the agent closes its own loop.
- Prompt structure: bullet points over prose; put critical instructions first (models exhibit
  "lost in the middle"); don't duplicate an instruction in both CLAUDE.md and the message.

**Tools & always-on context**
- **CLAUDE.md is in every prompt** — keep it under ~200 lines, durable project facts only
  (architecture, conventions, gotchas, commands Claude can't guess). Litmus test per line:
  "would removing this cause a mistake? if not, cut it." A bloated CLAUDE.md makes Claude ignore
  the instructions that matter. Move sometimes-relevant workflows into **Skills** (load on demand,
  ~100-token metadata footprint) and path-scoped rules.
- **MCP tool definitions** used to be a silent killer (~1.5–3k tokens/server, always present).
  Tool Search (on by default since v2.1.7) defers schema loading — ~85% overhead reduction. Still
  disable unused servers, and **prefer CLI tools** (`gh`, `aws`, `gcloud`) which add zero listing
  overhead. Tool-selection accuracy also degrades past ~30–50 available tools.

---

## 3. Counterintuitive truths (so cards don't give naive advice)

- **More verbose *instructions* can lower *total* tokens** — a detailed first prompt (constraints,
  file list, tests to run) costs more up front but avoids rounds of clarification and rework.
- **Compacting proactively is cheaper than letting history grow** — the extra call reuses the
  cache and shrinks every future turn.
- **Splitting across sessions can beat one big-brain session** — new-session overhead is repaid
  by smaller per-turn context and better locality.
- **Concise *output* helps**, but a "be terse" CLAUDE.md only nets out when output volume is
  high (it taxes every input turn). Don't praise/criticize terseness blindly.
- **Sometimes you *should* let context accumulate** — a single deep, coherent problem can warrant
  it. The grade is about *waste*, not raw size; a large but unavoidable task can still be a 5.

---

## 4. What good looks like (reward these)

- **Context kept lean.** Little spend above the panic threshold; `/compact` or fresh session at
  task boundaries; context reset *before* it ballooned, not after.
- **Tight scoping.** One coherent task per session; `/clear` between unrelated work; narrow
  file/line reads, not whole-repo sweeps.
- **Heavy reads offloaded** to subagents that return only summaries.
- **Right model for the job** (Sonnet default, Haiku subagents, Opus reserved).
- **Plan-then-execute** for multi-file/uncertain work; verification targets given up front.
- **Cache protected** — no needless mid-session model/effort/CLAUDE.md churn.
- **Batched commands** — independent commands grouped into one step.
- **Thinking dialed down for execution** — `/effort` lowered (or thinking toggled off) once
  planning was done, so rote steps didn't carry full reasoning.
- **Review done in a fresh session** off the committed diff, not stacked on the implementation
  context.

## 5. What hurts (penalize these)

- **Kitchen-sink session** — context driven high and held there, no `/compact`/`/clear` at
  boundaries. *The single biggest failure mode.*
- **Correction spiral** — same issue re-corrected >2×, cluttering context with dead approaches.
- **Reasoning on every step** — extended thinking left on through execution, so interleaved
  thinking fires on every mechanical Write/Bash (it scales with step count; billed ~5× input)
  instead of being dialed down once the plan was settled.
- **Bulky results carried** — big logs/files/search dumps re-read step after step instead of
  delegated or filtered.
- **Wrong model / wrong fan-out** — Opus on mechanical work; multi-agent teams on tightly-coupled
  tasks (~7–15× the tokens) where it doesn't parallelize.
- **Cache churn** — frequent model/effort/CLAUDE.md changes inflating `cache_creation`.
- **Bloated always-on context** — oversized CLAUDE.md (>~200 lines) or many unused MCP servers
  taxing every turn before the user even types.
- **Review piled on the implementation context** — `/code-review` / `/simplify` run in the same
  session that built the feature, re-reading the whole implementation window instead of starting
  fresh from the committed diff.

---

## 6. Scoring 1–5

Anchor the grade to **how much of THIS bill was avoidable** (re-reading above the threshold +
carried tool results + reasoning overhead), tempered by whether the levers above were used.

- **5 — Excellent.** Almost nothing avoidable (<~5% of cost). Context disciplined, work scoped,
  heavy lifting offloaded. Hard to spend less without doing less.
- **4 — Good.** Mostly efficient (<~15% avoidable). One minor lever left on the table.
- **3 — Fair.** A sizable share avoidable (~15–30%). Real, fixable habits — context held too
  long, some unbatched reasoning, a few heavy reads kept in-thread.
- **2 — Poor.** Most of the bill avoidable (~30–50%). Context ran hot for much of the session;
  obvious `/compact` / subagent / scoping opportunities missed.
- **1 — Very poor.** Bill dominated by avoidable overhead (>~50%). Kitchen-sink session: huge
  context held throughout, reasoning on nearly every step, no resets.

State numbers when you have them ("$3.43, 76% of the bill, went to reasoning across 148/155
steps"). Grade the *driving habits*, not the raw dollar total — a large but unavoidable task can
still earn a 5; a cheap session bloated with waste can earn a 2.

---

## 7. Writing cards

Produce **3–6 cards**, each a `{verdict, title, what, why, how}` object:

- `verdict`: `good` (something done well), `bad` (a real cost problem), or `warn` (a habit to
  watch / mixed). Include at least one `good` card when the session earned it — the report is a
  review, not just a scolding.
- `title`: 3–6 words, the headline of the finding.
- `what`: what happened, quantified from the session's own numbers.
- `why`: why it cost (or saved) — trace it to a §1 mechanism (cache re-read, step multiplication,
  thinking-as-output, context rot).
- `how`: the forward action, with the relevant §2 lever named. For `bad`/`warn` this is **how to
  fix it next time**; for `good` it is **how to keep doing it** (what to replicate) — reinforcement,
  not a fix. Omit `how` only if there is genuinely nothing to add.

Be specific and quantified, not generic. Name the costly skill and its dollar figure; point at
the concrete file/command that dominated context; say which prompt drove the reasoning; pick the
*highest-value* lever for the fix (usually a smaller context before a cosmetic tweak).

### Voice — write so a non-expert can act on it

The reader may not know Claude Code's cost internals. Write every card, **especially `how`**, in
plain, concrete language a newcomer can act on without a glossary.

- **No bare jargon.** Don't write "batch your steps", "gate thinking", "the cache_read prefix",
  "fan-out", "step multiplication" and stop there. Either avoid the term or, the first time you use
  it, say in plain words what it means. "Batch" → *"make all your edits first, then run the test
  command once at the end instead of after every edit."* "Gate thinking" → *"once you've
  finished planning, drop `/effort` to low (or toggle thinking off with `Alt+T`) so the model
  stops over-reasoning on simple steps like posting a reply or re-running a check."*
- **`how` is a recipe, not a label.** Spell out the concrete action: the command to type
  (`/compact`, `/clear`, `/effort low`, `--model sonnet`), the habit to change, what to do
  differently *and when*. The reader should be able to do it next session without guessing. Tie the
  saving to the action ("…**this** is what recovers the ~$0.29"), not leave it floating.
- **Plain words over jargon** throughout `what`/`why` too: "re-reading the whole conversation each
  step" beats "cache_read dominance"; "the window got large and stayed large" beats "context held
  above the soft cap". Keep the precise numbers; lose the insider vocabulary.
- **One idea per sentence.** Short sentences. If a card needs two actions, give them as two plain
  steps, not one dense clause.
