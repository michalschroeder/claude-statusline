# Session detail view — `sessions.js <id>`

A per-session cost drill-down for the viewer. Answers "what consumed the most in
this session" by splitting the recomputed cost across token types, models, the
user prompts that drove it, and subagents.

Pure-Node-stdlib, no deps. The detail data + rendering are pure (string in →
string out); they parse the session's transcript directly (the cost cache keeps
only `{id, dayKey, cost}` per call and discards the token breakdown / turn
structure needed here). An interactive arrow-key picker is explicitly **out of
scope** (planned as a later follow-up).

## Invocation & selection

A bare positional arg (not starting with `--`) switches the viewer to detail
mode; with no positional arg the list view is unchanged. The arg is matched as a
**prefix** against the full session ids from `listSessions`:

- exactly one match → render the detail view;
- zero matches → `no session matching '<prefix>'` to stderr, exit 1;
- multiple matches → `'<prefix>' is ambiguous:` followed by the matching ids,
  exit 1.

`--config-dir` still applies (same transcript-root resolution as list mode).
`--last` / `--since` are accepted but ignored in detail mode. `parseArgs` gains
`opts.detail` = the first bare token (only the first; a second bare token is an
error: `unexpected argument '<tok>'`, exit 1).

## Cost breakdown — `lib/cost-compute.js`

Add `calculateCostBreakdown(usage, costs)` returning
`{ input, output, cacheWrite, cacheRead, web, total }` (USD per component;
`cacheWrite` = 5-minute + 1-hour writes combined). Reimplement the existing
`calculateCost` as `calculateCostBreakdown(...).total` so the single-number path
and the itemized path can never drift. All current `calculateCost` behavior
(fast multiplier, `above200k` tier, web search, the `× 1.6` 1-hour cache-write
premium) is preserved and applied per component.

## Detail builder — `lib/session-detail.js` (pure, testable)

`buildDetail(mainFile, subagentFiles, pricing)` → a structured object. It parses
the session's own transcripts and applies the **same dedup as `aggregate`** so
the detail total equals the list view's COST:

- within a file: keep the **last** occurrence per `message.id` (final usage),
  carrying the first occurrence's timestamp; id-less calls are always kept;
- across files: **first occurrence wins**, files processed **oldest mtime
  first** (main + subagent files together).

Unlike `parseFileCalls`, it retains each deduped call's `model` and `usage` (and
which file it came from) so the breakdowns below can be computed.

Returned shape:

```
{
  total,                       // session total USD (== list COST)
  calls,                       // count of deduped billed calls
  components: { input, output, cacheWrite, cacheRead, web },  // USD summed
  byModel: [ { model, cost, calls } ],            // desc by cost
  byAgent: [ { name, cost } ],                    // 'main' + each agent-*; desc by cost
  topPrompts: [ { text, cost, calls } ],          // main-session turns, desc by cost
  subagentTotal, subagentCount,                   // for the "+ $X across N subagents" line
}
```

### Turn attribution (Top Prompts)

Walk the **main** transcript in order. A **genuine user prompt** is a `user`
message whose `message.content` is a string, or an array containing a `text`
block and **no** `tool_result` block (tool results come back as user-role
messages and must not count as prompts). Each assistant call's cost accrues to
the currently-active prompt until the next genuine prompt; calls before the first
prompt accrue to a `(session start)` bucket. Prompt text is whitespace-collapsed;
a slash-command message (`<command-name>/foo</command-name>` form) is shown as
`/foo`. Subagent calls are **not** attributed to main prompts — they appear only
in `byAgent` and are folded into `total` / `components` / `byModel`;
`subagentTotal`/`subagentCount` carry the "+ $X across N subagents" summary.

### File discovery

Main file = the `listSessions` `file` for the resolved id. Subagent files =
`<projectDir>/<id>/subagents/agent-*.jsonl` (sibling of the main file), matched
the same way `aggregate` does (only `agent-*.jsonl`). `byAgent` names: `main` for
the main file, the `agent-XXXX` stem for each subagent file.

## Rendering — `renderDetail(detail, sessionId, when, title, recap, width)` in `bin/sessions.js`

Dim section headers; money + proportion bars reuse `lib/color.js`. **No** budget
coloring (single-session view, not budget-relative). Layout:

```
SESSION b6c32a08-84f1-43c7-895c-3f37d25c84d5
Improve sessions.js command UI for terminal
└ Goal: polish the bin/sessions.js viewer UI…
Tue Jun 09 01:53 · 9 calls · $16.79 total

WHERE IT WENT
  cache-read   ▓▓▓▓▓▓▓░░░  68%  $11.42
  input        ▓▓░░░░░░░░  19%   $3.19
  output       ▓░░░░░░░░░   9%   $1.51
  cache-write  ▓░░░░░░░░░   4%   $0.67

BY MODEL
  claude-opus-4-8    $16.79   9 calls

TOP PROMPTS
  $9.12  6 calls  refactor the cost pipeline and split into libs
  $4.03  3 calls  now add the budget bar footer
  $1.55  2 calls  fix the failing test
  + $2.69 across 2 subagents

BY AGENT
  main           $14.10
  agent-a1b2c3    $2.69
```

Details:
- Header: `SESSION <full id>`, then title (or `—`), then a dim `└ recap`
  sub-line when a recap exists, then `<dayLabel clock> · N calls · $T total`.
  Title/recap reuse `readTitleRecap`; `when` from the `listSessions` row.
- `WHERE IT WENT`: rows for cache-read / input / output / cache-write (and
  `web search` only when `components.web > 0`), each ≤ 10-cell `▓`/`░` bar
  (fill = round(component/total × 10)), `N%` (of total), and the component USD.
  Rows sorted desc by component cost. Components that are $0 are omitted.
- `BY MODEL`: one row per model, USD + call count, desc by cost.
- `TOP PROMPTS`: up to **10** rows, `$cost  N calls  <prompt text>` truncated to
  width. When subagents exist, a final dim `+ $X across N subagents` line.
- `BY AGENT`: only rendered when subagents exist; `main` + each `agent-*`, desc
  by cost.
- Width via the existing `termWidth()` helper; all numbers right-aligned within
  their section so columns line up. Money formatting reuses the in-file `money`
  helper (hoisted to module scope so both the list footer and detail share it).

## Offline / pricing

Same as list mode: `loadPricing(stateDir, { allowFetch: false })` (no network,
no `pricing.json` write); the detail view reuses the `pricing` already loaded in
`main()`.

## Testing

- `tests/cost-compute.test.js`: extend — `calculateCostBreakdown` components sum
  to `calculateCost`; each component priced correctly (input/output/cacheRead,
  5m vs 1h cacheWrite, web, fast multiplier, above200k tier).
- `tests/session-detail.test.js` (new, pure): dedup parity (detail `total`
  equals an `aggregate` run over the same files); token-type component split;
  `byModel` aggregation + counts; turn attribution (tool_result messages don't
  start a prompt; slash-command rendered as `/name`; pre-prompt calls →
  `(session start)`); subagent split (`byAgent`, `subagentTotal/Count`); empty
  session (no billed calls) → zeros, no crash.
- `tests/sessions-viewer.test.js` (extend): `sessions.js <prefix>` renders the
  section headers and a dollar total; unknown prefix → exit 1 with
  `no session matching`; ambiguous prefix → exit 1 listing matches; a bare
  positional does not break list mode when absent.

## Out of scope (future follow-up)

Interactive arrow-key picker (raw-mode TTY navigation, Enter → detail). Recorded
separately; not part of this spec.

## Open questions

None.
