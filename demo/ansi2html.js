// ANSI → standalone HTML page for demo/screenshot-png.sh. Handles only the SGR
// codes the statusline emits (reset, bold, dim, base colours, 256-colour fg).
// Usage: <ansi on stdin> | node demo/ansi2html.js <out.html>
const fs = require('fs');
const src = fs.readFileSync(0, 'utf8');
const base = { 31: '#f28b8b', 32: '#a6da95', 33: '#eed49f', 35: '#f5bde6', 36: '#8bd5ca' };
const x256 = (n) => {
  if (n < 16) return null;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const c = (v) => (v ? 55 + v * 40 : 0);
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let st = {}, out = '';
for (const part of src.split(/(\x1b\[[0-9;]*m)/)) {
  const m = part.match(/^\x1b\[([0-9;]*)m$/);
  if (!m) {
    if (!part) continue;
    const css = [];
    if (st.color) css.push(`color:${st.color}`);
    if (st.bold) css.push('font-weight:bold');
    if (st.dim) css.push('opacity:.55');
    out += css.length ? `<span style="${css.join(';')}">${esc(part)}</span>` : esc(part);
    continue;
  }
  const codes = (m[1] || '0').split(';').map(Number);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) st = {};
    else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 38 && codes[i + 1] === 5) { st.color = x256(codes[i + 2]); i += 2; }
    else if (base[c]) st.color = base[c];
  }
}
fs.writeFileSync(process.argv[2], `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#2d303d}
pre{margin:0;padding:12px 16px;color:#d4d7e0;font:16px/1.6 'JetBrainsMono Nerd Font',monospace;white-space:pre}
</style><pre>${out}</pre>`);
