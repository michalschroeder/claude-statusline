---
name: session-cost-analyzer
description: >-
  Analyze why a Claude Code session was expensive — break down its cost by token type,
  model, turn, and subagent, and produce an HTML report. Use when the user asks where a
  session's cost or tokens went, why a session was costly, to analyze or audit token or
  dollar spend, to list recent sessions by cost, or mentions session cost, /compact
  savings, or context growth. Args: `[<session-id-prefix> | list]
  [--config-dir <path>] [--out <path>] [--last N] [--since YYYY-MM-DD]`. Examples:
  `/session-cost-analyzer 848c5b25`,
  `/session-cost-analyzer list --last 20 --config-dir ~/.claude-lendable`.
argument-hint: "[<session-id-prefix> | list] [--config-dir <path>] [--out <path>] [--last N] [--since YYYY-MM-DD]"
---

# Session Cost Analyzer

Drives `scripts/analyze.js` (self-contained, JSON-only) to explain a session's cost.

## Location — read first

The scripts are **bundled inside this skill** (pure Node stdlib, no install) — they do **NOT**
live in the user's repo, so don't `cd` there expecting to find them.

Every command below references the scripts via **`${CLAUDE_SKILL_DIR}`** — the Claude Code
substitution that expands to this skill's directory (works from any working directory). It is
already expanded to an absolute path in the text you are reading, so run the commands verbatim.
Without `--out` the report is written into the current working directory as
`session-cost-<shortid>.html`; the renderer prints the absolute path it wrote — relay that to
the user.

(Fallback: if a command ever shows a literal, unexpanded `${CLAUDE_SKILL_DIR}` or resolves to
an empty path, substitute the absolute path from the `Base directory for this skill: …` line
the loader printed.)

## Arguments

`/session-cost-analyzer [<session-id-prefix> | list] [flags]` — parse the invocation for
these tokens **before** running the workflow; they map deterministically to the steps below.

| Token | Effect |
|---|---|
| `<session-id-prefix>` | Analyze that session (detail report). Omit → ask which (step 1). |
| `list` | List recent sessions by cost instead of a detail report. |
| `--config-dir <path>` | Non-default transcript root (e.g. `~/.claude-lendable`). Passed straight to `analyze.js`. |
| `--out <path>` | Report output path. Default: `./session-cost-<shortid>.html` in the current working directory. |
| `--last N` / `--since YYYY-MM-DD` | `list`-mode filters. |

A **detail report always** includes the model-written copy (step 5): the top-turns and
context-consumer cells, and the "Spending less next time" assessment — no opt-in flag, the
subagent flow runs every time. (`list` mode produces no detail, so step 5 doesn't apply there.)
Unknown flags: ignore.

### Examples

```bash
/session-cost-analyzer 848c5b25                # detail report (always model-written)
/session-cost-analyzer list --last 20          # rank recent sessions by cost
/session-cost-analyzer 848c5b25 --config-dir ~/.claude-lendable
```

## Workflow

1. **Select the session.**
   - If the user gave a session id/prefix, skip to step 2 with it.
   - Otherwise run `node ${CLAUDE_SKILL_DIR}/scripts/analyze.js list --last 10`, summarize the sessions
     inline (`title · $cost · age`), and ask which one to analyze.

2. **Pull the detail.** Run
   `node ${CLAUDE_SKILL_DIR}/scripts/analyze.js <prefix> > /tmp/detail.json` once, then read
   and parse that file. Step 5 reuses it — don't re-run `analyze.js` (each run re-parses the
   whole transcript tree). Read the `legend` field first — it states the cost model.

3. **Read the precomputed rollups, do NOT hand-aggregate `calls[]`.**
   Use `summary.contextGrowth`, `summary.byTurnKind`, `summary.toolTally`,
   `summary.highContextCost`, `summary.contextResets`, and `summary.contextConsumers`
   (names the exact files/commands whose results filled the context, with estimated
   tokens and the carried re-read cost — lead with these when the user asks WHAT
   consumed the context). When `assistant-thinking` dominates the consumers, drill into
   `summary.assistantOutput.thinking` — stored vs unstored (interleaved) thinking, the
   per-turn attribution in `thinking.byTurn`, and `thinking.peakStep` — to say WHICH
   prompts drove the reasoning. `summary.bySkill` links cost to skill usage — the turns
   each skill dispatch drove. Re-aggregating `calls[]` is a known trap: it over-counts
   tools ~3× and invents false "10× growth" from one early call. The script already
   computed the honest numbers — use them.

4. **Interpret** with the cost model in [REFERENCE.md](REFERENCE.md).

5. **Report (always model-written copy).**
   - Narrate the cost story inline (where the money went, the biggest lever).
   - Three things come from the model: the TOP TURNS prompt cell ("what this turn
     accomplished"), the TOP CONTEXT CONSUMERS target cell ("what this file/command/prompt was"),
     and the **"Spending less next time" assessment** (a 1–5 grade plus verdict-tagged
     WHAT/WHY/HOW cards). The THINKING "prompt that drove the reasoning" cell reuses the same turn
     summary by turnIndex, so terse prompts like "do it" become descriptive there too — no extra
     batch. Don't shell out to a model — dispatch **subagents** (the Agent tool) and merge their
     output through the helpers into the renderer. Dispatch **four**: one each for the turns and
     consumer batches (`model: haiku` — mechanical labelling), and **two for the assessment**, a
     draft pass then an adversarial critic pass, both on a **strong model** (Opus). Each subagent
     handles its whole batch in a single call (never one per row). The renderer formats
     money/duration/tokens, draws the proportion bars, ranks the top turns, HTML-escapes every
     prompt/title/label, prints the absolute path it wrote (`./session-cost-<shortid>.html` in the
     current working directory — pass `--out <path>` if the user names one; tell the user the
     path), and opens with an interactive context-window timeline (one SVG bar per step, colored by
     the 200k threshold, hover for per-step size/cost/prompt). (`assets/report-template.html` holds
     the styling if you need to tweak it.)

     ```bash
     # From /tmp/detail.json (written in step 2) gather the batches:
     #   • turns: sort `turns` by cost, take ~10 — hand ONE subagent ALL of them (each row's
     #     turnIndex + kind + tool tally + prompt); it returns the whole
     #     { "<turnIndex>": "<summary>", ... } map.
     #   • consumers: from `summary.contextConsumers.top` take the top ~10 NON-synthetic
     #     rows (skip rows with `synthetic: true` — those are already-labelled rollups)
     #     — hand ONE subagent ALL of them (each row's index in `top` + tool + target); it
     #     returns the whole { "<index>": "<summary>", ... } map.
     #     Ask for a descriptive 1-2 sentence phrase (~30-45 words) per row saying concretely
     #     WHAT the item is/did — not a terse label.
     #   • tips (the assessment) — TWO strong-model passes:
     #     1. DRAFT. Hand the subagent the rubric EVALUATION.md
     #        (${CLAUDE_SKILL_DIR}/EVALUATION.md — it defines what a 1-5 grade means and what to
     #        reward/penalize) AND the whole detail JSON — especially `summary` (totalCost,
     #        byTurnKind, bySkill, highContextCost, contextResets, contextConsumers,
     #        assistantOutput.thinking) and the costliest `turns`/`topPrompts`. Ask it to GRADE
     #        the session 1-5 per the rubric and return { rating, headline, cards }, 3-6 cards
     #        each { verdict, title, what, why, how }:
     #          - verdict: "good" (done well), "bad" (a real cost problem), or "warn" (watch it).
     #            Include ≥1 "good" card when earned — it's a review, not just a scolding.
     #          - what: what happened, quantified from the session's numbers.
     #          - why:  why it cost (or saved) — tie to a rubric §1 mechanism (cache re-read,
     #            step multiplication, thinking-as-output, context rot).
     #          - how:  the fix (name the rubric §2 lever) on bad/warn cards; on a "good" card,
     #            what to KEEP doing. Write it as a concrete recipe (the command to type, the habit
     #            to change, and when) — NOT a jargon label. See EVALUATION.md §7 "Voice".
     #        Name the costly skill + its $, the file/command that dominated context, the prompt
     #        that drove the reasoning. Be specific and quantified, not generic advice. PLAIN
     #        LANGUAGE: the reader may not know Claude Code internals — no bare jargon ("batch",
     #        "gate thinking", "cache_read"); explain any term the first time, prefer plain words
     #        ("re-reading the whole conversation each step" over "cache_read dominance").
     #     2. CRITIC (adversarial). Hand a SECOND strong-model subagent the rubric, the detail
     #        JSON, AND the draft. Tell it to REFUTE the draft: is the 1-5 grade defensible
     #        against the avoidable-share anchor (don't drift to a soft "3")? What real lever did
     #        the draft miss, overstate, or misattribute (e.g. blaming a terse prompt for what
     #        was really context size)? Are the numbers right? ALSO rewrite any card a non-expert
     #        couldn't act on: strip jargon, and make each `how` a concrete recipe (command to type
     #        + when), per EVALUATION.md §7 "Voice". It returns the FINAL corrected
     #        { rating, headline, cards } in the same shape — this is what gets merged.
     # Merge into ONE /tmp/summaries.json, namespaced by section (tips = the critic's final):
     #   { "turns":     { "<turnIndex>": "<summary>", ... },
     #     "consumers": { "<index>":     "<summary>", ... },
     #     "tips":      { "rating": 2, "headline": "Context ran hot for most of it.",
     #                    "cards": [ { "verdict": "bad", "title": "Kept context huge",
     #                                 "what": "…", "why": "…", "how": "…" }, ... ] } }
     # (A flat { "<turnIndex>": ... } map is still accepted but applies to turns only; a legacy
     #  `tips` LIST of { head, body } cards is also accepted → what-only warn cards, no grade.)
     node ${CLAUDE_SKILL_DIR}/scripts/apply-summaries.js --summaries /tmp/summaries.json < /tmp/detail.json \
       | node ${CLAUDE_SKILL_DIR}/scripts/render-report.js
     ```

     `apply-summaries.js` merges the JSON in (turns by `turnIndex`, consumers by their index in
     `summary.contextConsumers.top`, tips → `summary.aiAssessment`) and the renderer fills the
     cells from it, keeping the raw prompt/target one hover away. The assessment is AI-only:
     **always run the four subagents above** — if `aiAssessment` is missing, the grade section
     renders empty.

## Notes

- Costs are recomputed from raw tokens × LiteLLM prices — never Claude's reported cost.
- The analyzer is offline; it uses the bundled `data/model_prices.json` snapshot.
