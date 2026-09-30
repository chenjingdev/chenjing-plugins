// 터미널과 같은 색을 쓰려고 Ghostty 설정(cmux·Orca도 읽는 파일)에서 배경·글자 색을 가져온다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEX = /^#?([0-9a-f]{6})$/i;

function parse(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function themeDirs() {
  const h = os.homedir();
  return [
    path.join(h, '.config', 'ghostty', 'themes'),
    '/Applications/Ghostty.app/Contents/Resources/ghostty/themes',
    '/Applications/cmux.app/Contents/Resources/ghostty/themes',
  ];
}

const color = (v) => (typeof v === 'string' && HEX.test(v) ? `#${v.match(HEX)[1].toLowerCase()}` : null);

export function terminalColors(file = path.join(os.homedir(), '.config', 'ghostty', 'config')) {
  let cfg;
  try { cfg = parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  let background = color(cfg.background);
  let foreground = color(cfg.foreground);
  if ((!background || !foreground) && cfg.theme) {
    // "light:이름,dark:이름" 꼴이면 어두운 쪽을 쓴다
    const name = cfg.theme.includes(':') ? (cfg.theme.match(/dark:([^,]+)/)?.[1] || '').trim() : cfg.theme;
    for (const dir of themeDirs()) {
      if (!name || name.includes('/') || name.includes('..')) break;
      try {
        const t = parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        background ||= color(t.background);
        foreground ||= color(t.foreground);
        break;
      } catch { /* 다음 위치 */ }
    }
  }
  return background && foreground ? { background, foreground } : null;
}
