#!/usr/bin/env node
// Claude Code Statusline - Enhanced Edition

const fs = require('fs');
const path = require('path');
const os = require('os');

// ANSI helpers
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const orange = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
const blink_red = (s) => `\x1b[5;31m${s}\x1b[0m`;
const dimCyan = (s) => `\x1b[2;36m${s}\x1b[0m`;

// Icon sets — three tiers. nerd: requires Nerd Font. unicode: BMP-only fallback.
// ascii: pure ASCII (works on any terminal/font).
const ICON_SETS = {
  nerd:    { effort: '󰾅', branch: '󰘬', worktree: '󰘯', dir: '󰉋', duration: '󰔛',
             lines: '󰷈', r5h: '󰔚 5h', r7d: '󰃭 7d', rsep: '·', skull: '󰚌',
             style: '󰏘', vim: '', agent: '󰚩',
             barFill: '█', barEmpty: '░',
             sep: '┊', skills: '', hr: '─' },
  unicode: { effort: '⚡', branch: '⎇', worktree: '⊕', dir: '▸',  duration: '⏱',
             lines: 'Δ', r5h: '5h', r7d: '7d', rsep: '·', skull: '‼',
             style: '❖', vim: 'V', agent: '◉',
             barFill: '█', barEmpty: '░',
             sep: '┊', skills: '✦', hr: '─' },
  ascii:   { effort: '!', branch: 'git:', worktree: 'wt:', dir: 'dir:', duration: 't:',
             lines: 'd', r5h: '5h', r7d: '7d', rsep: ',', skull: '!!',
             style: 'S', vim: 'V', agent: '@',
             barFill: '#', barEmpty: '-',
             sep: '|', skills: '*', hr: '-' },
};

// Resolve icon mode. Priority: STATUSLINE_ICONS env > cached choice > first-run default.
// First run writes a cache file and signals (via returned `hint`) that we should
// append a one-time nudge to the statusline.
function resolveIconMode() {
  const env = process.env.STATUSLINE_ICONS;
  if (env && ICON_SETS[env]) return { mode: env, hint: false };

  const cacheFile = path.join(os.homedir(), '.cache', 'claude-statusline', 'icons');
  try {
    const cached = fs.readFileSync(cacheFile, 'utf8').trim();
    if (ICON_SETS[cached]) return { mode: cached, hint: false };
  } catch {}

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, 'ascii\n');
  } catch {}
  return { mode: 'ascii', hint: true };
}

/**
 * Format a number with k/M suffixes for compact display.
 * 523 → "523", 4500 → "4.5k", 15000 → "15k", 1200000 → "1.2M"
 */
function formatCompact(n) {
  if (n == null || n <= 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/**
 * Read current git branch from .git/HEAD directly (no subprocess).
 * Supports worktrees (.git file with gitdir: indirection).
 * Returns '' on any failure.
 */
function getGitBranch(projectDir) {
  try {
    let gitPath = path.join(projectDir, '.git');
    const stat = fs.statSync(gitPath);

    // Worktree support: .git is a file containing "gitdir: <path>"
    if (stat.isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (!match) return '';
      gitPath = path.resolve(projectDir, match[1]);
    }

    const headPath = path.join(gitPath, 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();

    // Normal branch: "ref: refs/heads/feature/my-branch"
    if (head.startsWith('ref: refs/heads/')) {
      return head.slice('ref: refs/heads/'.length);
    }

    // Detached HEAD: return short hash
    if (/^[0-9a-f]{40}$/.test(head)) {
      return head.slice(0, 7);
    }

    return '';
  } catch {
    return '';
  }
}

/**
 * Format cost as $X.XX with color thresholds.
 */
function formatCost(totalCost) {
  if (totalCost == null || totalCost <= 0) return '';
  const formatted = '$' + totalCost.toFixed(2);
  if (totalCost < 1) return green(formatted);
  if (totalCost < 5) return yellow(formatted);
  if (totalCost < 10) return orange(formatted);
  return red(formatted);
}

/**
 * Format milliseconds as compact human duration: 45s, 10m, 1h 5m.
 */
function formatDuration(ms, icon) {
  if (ms == null || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${icon} ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${icon} ${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${icon} ${h}h ${rem}m` : `${icon} ${h}h`;
}

// Context-bar palette (256-color, muted "ramp B" — forest-green → dark-red).
// One color per cell; cell N uses CTX_RAMP[N] when filled. Empty cells use CTX_EMPTY.
const CTX_RAMP = [34, 70, 106, 142, 178, 214, 208, 202, 196, 160];
const CTX_EMPTY = 240;
const fg256 = (code, s) => `\x1b[38;5;${code}m${s}\x1b[0m`;

/**
 * Build context bar with per-cell colored progress indicator.
 *
 * 10 cells, each colored by CTX_RAMP[index] when filled (fades green→red as the
 * bar grows). Empty cells are dim grey. Step size and panic threshold scale with
 * the model.
 *
 *   200k model: cell N fills at 20k·N tokens
 *               · early warning (blink+skull) ≥ 160k (80% — restores prior contract)
 *   1M model:   cell N fills at 50k·N tokens
 *               · panic (blink+skull) ≥ 500k (user-defined danger line)
 *
 * 1M detection: inferred total = inputTokens / (usedPct/100). Engages only when the
 * inferred total lands close to 1M (within ±200k → band (800k, 1.2M)). Outside that
 * narrow band — including cumulative-session interpretations that fall in (500k, 800k)
 * — we use 200k thresholds. When inputTokens is missing OR the inference is unreliable
 * (usedPct=0), falls back to percentage-driven fill (10% per cell, panic at ≥80%).
 *
 * displayPct = bar fill (% of the panic threshold). In panic the label is capped
 * at 100% — the skull+blink already signals the severity; the bar itself is full.
 */
function buildContextBar(usedPct, inputTokens, icons) {
  if (usedPct == null) return '';

  const canInferTotal = inputTokens > 0 && usedPct > 0;
  const inferredTotal = canInferTotal ? inputTokens / (usedPct / 100) : 0;
  // Tighter band: must be within ±200k of 1M. Catches cumulative-token leaks in (500k, 800k)
  // that the older (500k, 1.3M) band let through.
  const isLargeCtx = inferredTotal > 800_000 && inferredTotal < 1_200_000;
  const panicTokens = isLargeCtx ? 500_000 : 200_000;
  const stepTokens = panicTokens / 10;
  // Early warning: trigger panic at cell 8 (80% of bar) for the 200k tier so we don't
  // regress the prior "blink+skull at 80%" contract. The 1M tier keeps panic at the
  // last cell (500k) as explicitly requested by the user.
  const panicCell = isLargeCtx ? 10 : 8;

  // Use the token-driven path only when we can trust the inference. usedPct=0 with
  // non-zero inputTokens makes inference undefined → fall back to the percent path
  // (which renders 0 cells, no premature coloring of a possibly-1M session).
  const useTokenPath = inputTokens > 0 && canInferTotal;

  // displayPct is the raw "% of context window used" from the payload — what the user
  // expects when they see "N%". The bar fill is a separate signal calibrated to the
  // panic threshold; the two diverge on the 1M tier (e.g. 218k tokens of a 1M model
  // shows label "22%" with bar at 4/10 cells because 218k is 22% of the window but
  // 44% of the way to the 500k danger line).
  const displayPct = Math.max(0, Math.min(100, Math.round(usedPct)));

  let filled, isPanic = false;
  if (useTokenPath) {
    filled = Math.min(10, Math.floor(inputTokens / stepTokens));
    if (filled >= panicCell) {
      isPanic = true;
      filled = 10;
    }
  } else {
    // Restore the prior contract: blink+skull at ≥80% when the renderer is in fallback.
    if (displayPct >= 80) isPanic = true;
    filled = Math.min(10, Math.floor(displayPct / 10));
  }

  if (isPanic) {
    const bar = icons.barFill.repeat(10);
    return blink_red(`${icons.skull} ${bar} ${displayPct}%`);
  }

  let bar = '';
  for (let i = 0; i < 10; i++) {
    bar += i < filled
      ? fg256(CTX_RAMP[i], icons.barFill)
      : fg256(CTX_EMPTY, icons.barEmpty);
  }
  return `${bar} ${displayPct}%`;
}

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const homeDir = os.homedir();

    // Extract data fields
    const model = data.model?.display_name || 'Claude';
    const dir = data.workspace?.current_dir || process.cwd();
    const projectDir = data.workspace?.project_dir || dir;
    const session = data.session_id || '';
    const usedPct = data.context_window?.used_percentage ?? (data.context_window?.remaining_percentage != null ? 100 - data.context_window.remaining_percentage : null);
    const totalCost = data.cost?.total_cost_usd;
    const inputTokens = data.context_window?.total_input_tokens;
    const linesAdded = data.cost?.total_lines_added;
    const linesRemoved = data.cost?.total_lines_removed;
    const effortLevel = data.effort?.level;
    const thinkingEnabled = data.thinking?.enabled;
    const vimMode = data.vim?.mode;
    const agentName = data.agent?.name;
    const sessionName = data.session_name;
    const outputStyle = data.output_style?.name;
    const rateLimitFiveHour = data.rate_limits?.five_hour?.used_percentage;
    const rateLimitSevenDay = data.rate_limits?.seven_day?.used_percentage;
    const totalDurationMs = data.cost?.total_duration_ms;
    const addedDirs = data.workspace?.added_dirs;
    const worktreeName = data.worktree?.name || data.workspace?.git_worktree;
    const version = data.version;

    const { mode: iconMode, hint: iconHint } = resolveIconMode();
    const icons = ICON_SETS[iconMode];

    const segments = [];
    const add = (name, value) => segments.push({ name, value });


    // Model
    add('model', dim(model));

    // Effort + thinking
    if (effortLevel) add('effort', yellow(`${icons.effort} ${effortLevel}`));

    // Loaded skills (all unique, most-recent-first; written by Skill PreToolUse + /skill UserPromptSubmit hooks)
    let allSkills = [];
    if (session) {
      try {
        const stateDir = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
        const lines = fs
          .readFileSync(path.join(stateDir, 'claude-statusline', 'skills', `${session}.log`), 'utf8')
          .trim()
          .split('\n');
        const seen = new Set();
        for (let i = lines.length - 1; i >= 0; i--) {
          const name = lines[i].split(' ').slice(1).join(' ');
          if (!name || seen.has(name)) continue;
          seen.add(name);
          allSkills.push(name);
        }
      } catch {}
    }

// Output style (only when non-default)
    if (outputStyle && outputStyle.toLowerCase() !== 'default') add('style', dim(`${icons.style} ${outputStyle}`));

    // Vim mode
    if (vimMode) add('vim', dim(`${icons.vim} ${vimMode}`));

    // Git branch — hidden inside a worktree when branch is the expected
    // `worktree-<name>` (the ⊕ chip already conveys it). Surfaces only when
    // the branch has diverged from that convention (manual checkout, detached
    // HEAD, rename, etc.).
    const branch = getGitBranch(projectDir);
    const expectedWorktreeBranch = worktreeName ? `worktree-${worktreeName}` : null;
    if (branch && branch !== expectedWorktreeBranch) {
      const MAX = 50;
      const shown = branch.length > MAX
        ? `${branch.slice(0, 30)}...${branch.slice(-(MAX - 30 - 3))}`
        : branch;
      add('branch', dimCyan(`${icons.branch} ${shown}`));
    }

    // Worktree
    if (worktreeName) add('worktree', dim(`${icons.worktree} ${worktreeName}`));

    // Agent name
    if (agentName) add('agent', bold(`${icons.agent} ${agentName}`));

    // Directory (when inside a worktree, show the parent project name instead of the worktree dir)
    let dirLabel = path.basename(dir);
    if (worktreeName) {
      const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
      const idx = dir.indexOf(marker);
      if (idx !== -1) dirLabel = path.basename(dir.slice(0, idx));
    }
    add('dir', dim(`${icons.dir} ${dirLabel}`));

    // Added dirs
    if (addedDirs?.length) add('addeddirs', dim(`+${addedDirs.length}dir`));

    // Cost
    const costStr = formatCost(totalCost);
    if (costStr) add('cost', costStr);

    // Duration
    const durStr = formatDuration(totalDurationMs, icons.duration);
    if (durStr) add('duration', dim(durStr));

    // Lines changed
    const addedParts = [];
    if (linesAdded > 0) addedParts.push(green(`+${linesAdded}`));
    if (linesRemoved > 0) addedParts.push(red(`-${linesRemoved}`));
    if (addedParts.length > 0) add('lines', `${icons.lines} ${addedParts.join(' ')}`);

    // Rate limits (Claude.ai Pro/Max) — merged into one segment
    if (rateLimitFiveHour != null || rateLimitSevenDay != null) {
      const parts = [];
      if (rateLimitFiveHour != null) parts.push(`${icons.r5h} ${Math.round(rateLimitFiveHour)}%`);
      if (rateLimitSevenDay != null) parts.push(`${icons.r7d} ${Math.round(rateLimitSevenDay)}%`);
      add('ratelimits', dim(parts.join(` ${icons.rsep} `)));
    }

    // Context bar (with input token count appended)
    const ctxBar = buildContextBar(usedPct, inputTokens, icons);
    if (ctxBar) {
      const inStr = formatCompact(inputTokens);
      const suffix = inStr ? ` ${dim(`${icons.rsep} ${inStr}`)}` : '';
      add('context', `${ctxBar}${suffix}`);
    }

    // Optional allowlist + order via STATUSLINE_SEGMENTS env var.
    const filter = process.env.STATUSLINE_SEGMENTS;
    let final;
    if (filter && filter.trim()) {
      const allowed = filter.split(',').map((s) => s.trim()).filter(Boolean);
      const byName = new Map(segments.map((s) => [s.name, s.value]));
      final = allowed.map((n) => byName.get(n)).filter((v) => v);
    } else {
      final = segments.map((s) => s.value);
    }

    // Join all segments with dimmed separator
    let out = final.join(` ${dim(icons.sep)} `);
    if (iconHint) {
      out += `  ${dim('[icons=ascii; set STATUSLINE_ICONS=nerd|unicode|ascii \u2014 see README]')}`;
    }

    const termCols =
      process.stdout.columns ||
      process.stderr.columns ||
      parseInt(process.env.COLUMNS, 10) ||
      80;
    const width = Math.max(20, termCols);
    const rule = dim(icons.hr.repeat(width));
    out += `\n${rule}`;
    if (allSkills.length) {
      const full = allSkills
        .slice()
        .reverse()
        .map((n) => (n.includes(':') ? n.split(':').slice(1).join(':') : n))
        .join(', ');
      const title = bold(`${icons.skills} loaded skills:`);
      out += `\n${title} ${dim(full)}\n${rule}`;
    }

    process.stdout.write(out);
  } catch {
    // Silent fail - don't break statusline on parse errors
  }
});

