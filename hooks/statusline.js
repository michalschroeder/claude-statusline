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
  nerd:    { effort: '󰾅', branch: '⎇', worktree: '⊕', dir: '󰉋', duration: '⏱',
             lines: '󰷈', r5h: '󰔚 5h', r7d: '󰃭 7d', rsep: '·', skull: '\u{1F480}',
             up: '↑', down: '↓', barFill: '█', barEmpty: '░',
             sep: '│', skills: '\u{F5DC}', hr: '─' },
  unicode: { effort: '⚡', branch: '⎇', worktree: '⊕', dir: '▸',  duration: '⏱',
             lines: 'Δ', r5h: '5h', r7d: '7d', rsep: '·', skull: '‼',
             up: '↑', down: '↓', barFill: '█', barEmpty: '░',
             sep: '│', skills: '✦', hr: '─' },
  ascii:   { effort: '!', branch: 'git:', worktree: 'wt:', dir: 'dir:', duration: 't:',
             lines: 'd', r5h: '5h', r7d: '7d', rsep: ',', skull: '!!',
             up: '^', down: 'v', barFill: '#', barEmpty: '-',
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

/**
 * Build context bar with colored progress indicator.
 */
function buildContextBar(remaining, icons) {
  if (remaining == null) return '';
  const rem = Math.round(remaining);
  const used = Math.max(0, Math.min(100, 100 - rem));
  const filled = Math.floor(used / 10);
  const bar = icons.barFill.repeat(filled) + icons.barEmpty.repeat(10 - filled);
  const label = `${bar} ${used}%`;

  if (used < 50) return green(label);
  if (used < 65) return yellow(label);
  if (used < 80) return orange(label);
  return blink_red(`${icons.skull} ${label}`);
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
    const remaining = data.context_window?.remaining_percentage;
    const totalCost = data.cost?.total_cost_usd;
    const inputTokens = data.context_window?.total_input_tokens;
    const outputTokens = data.context_window?.total_output_tokens;
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
    const worktreeName = data.worktree?.name;
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
        const lines = fs
          .readFileSync(`/tmp/claude-skills-${session}.log`, 'utf8')
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
    if (outputStyle && outputStyle.toLowerCase() !== 'default') add('style', dim(`style:${outputStyle}`));

    // Vim mode
    if (vimMode) add('vim', dim(`vim:${vimMode}`));

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
    if (agentName) add('agent', bold(agentName));

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

    // Tokens
    const inStr = formatCompact(inputTokens);
    const outStr = formatCompact(outputTokens);
    if (inStr || outStr) {
      const parts = [];
      if (inStr) parts.push(`${inStr}${icons.up}`);
      if (outStr) parts.push(`${outStr}${icons.down}`);
      add('tokens', dim(parts.join(' ')));
    }

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

    // Context bar
    const ctxBar = buildContextBar(remaining, icons);
    if (ctxBar) add('context', ctxBar);

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

    if (allSkills.length) {
      const full = allSkills
        .slice()
        .reverse()
        .map((n) => (n.includes(':') ? n.split(':').slice(1).join(':') : n))
        .join(', ');
      const width = Math.max(20, Math.min(120, process.stdout.columns || 80));
      const rule = dim(icons.hr.repeat(width));
      const title = bold(`${icons.skills} loaded skills:`);
      out += `\n${rule}\n${title} ${dim(full)}\n${rule}`;
    }

    process.stdout.write(out);
  } catch {
    // Silent fail - don't break statusline on parse errors
  }
});

