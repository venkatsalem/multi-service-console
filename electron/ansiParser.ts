import { AnsiSpan, LogLevel } from '../shared/types';

const FG_COLORS: Record<number, string> = {
  30: '#4b5563',
  31: '#ef4444',
  32: '#22c55e',
  33: '#eab308',
  34: '#3b82f6',
  35: '#c084fc',
  36: '#06b6d4',
  37: '#e5e7eb',
  90: '#6b7280',
  91: '#f87171',
  92: '#4ade80',
  93: '#facc15',
  94: '#60a5fa',
  95: '#d8b4fe',
  96: '#22d3ee',
  97: '#ffffff'
};

const BG_COLORS: Record<number, string> = {
  40: '#1f2937',
  41: 'rgba(239, 68, 68, 0.25)',
  42: 'rgba(34, 197, 94, 0.25)',
  43: 'rgba(234, 179, 8, 0.25)',
  44: 'rgba(59, 130, 246, 0.25)',
  45: 'rgba(192, 132, 252, 0.25)',
  46: 'rgba(6, 182, 212, 0.25)',
  47: 'rgba(229, 231, 235, 0.25)',
  100: 'rgba(107, 114, 128, 0.3)',
  101: 'rgba(248, 113, 113, 0.28)',
  102: 'rgba(74, 222, 128, 0.28)',
  103: 'rgba(250, 204, 21, 0.28)',
  104: 'rgba(96, 165, 250, 0.28)',
  105: 'rgba(216, 180, 254, 0.28)',
  106: 'rgba(34, 211, 238, 0.28)',
  107: 'rgba(255, 255, 255, 0.22)'
};

// Strip OSC sequences and non-SGR CSI sequences while keeping SGR (\x1b[...m)
const NON_SGR_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-LN-Za-ln-z=><]|\x1b[()][AB012]|\x07/g;

// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[([0-9;]*)m/g;

export function parseAnsiLine(input: string): {
  raw: string;
  spans: AnsiSpan[];
} {
  const cleaned = input.replace(NON_SGR_ESCAPE_RE, '');
  const spans: AnsiSpan[] = [];
  let raw = '';

  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;

  let lastIndex = 0;
  SGR_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      const text = cleaned.slice(lastIndex, match.index);
      raw += text;
      spans.push({
        text,
        ...(fg ? { fg } : {}),
        ...(bg ? { bg } : {}),
        ...(bold ? { bold } : {}),
        ...(dim ? { dim } : {})
      });
    }

    const paramsRaw = match[1];
    const codes =
      paramsRaw.length === 0
        ? [0]
        : paramsRaw.split(';').map((part) => Number.parseInt(part, 10) || 0);

    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) {
        fg = undefined;
        bg = undefined;
        bold = false;
        dim = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) {
        fg = undefined;
      } else if (code === 49) {
        bg = undefined;
      } else if (FG_COLORS[code]) {
        fg = FG_COLORS[code];
      } else if (BG_COLORS[code]) {
        bg = BG_COLORS[code];
      } else if (code === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        fg = ansi256ToHex(codes[i + 2]);
        i += 2;
      } else if (code === 48 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        bg = ansi256ToHex(codes[i + 2]);
        i += 2;
      }
    }

    lastIndex = SGR_RE.lastIndex;
  }

  if (lastIndex < cleaned.length) {
    const text = cleaned.slice(lastIndex);
    raw += text;
    spans.push({
      text,
      ...(fg ? { fg } : {}),
      ...(bg ? { bg } : {}),
      ...(bold ? { bold } : {}),
      ...(dim ? { dim } : {})
    });
  }

  if (spans.length === 0) {
    spans.push({ text: '' });
  }

  return { raw, spans };
}

function ansi256ToHex(n: number): string {
  if (n < 16) {
    const table = [
      '#4b5563',
      '#ef4444',
      '#22c55e',
      '#eab308',
      '#3b82f6',
      '#c084fc',
      '#06b6d4',
      '#e5e7eb',
      '#6b7280',
      '#f87171',
      '#4ade80',
      '#facc15',
      '#60a5fa',
      '#d8b4fe',
      '#22d3ee',
      '#ffffff'
    ];
    return table[n] ?? '#e5e7eb';
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    const hex = v.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const toVal = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return (
    '#' +
    [toVal(r), toVal(g), toVal(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

const ERROR_PATTERNS = [
  /\b(ERROR|FATAL|SEVERE|CRITICAL|PANIC)\b/,
  /\b[A-Za-z0-9_.$]*(Exception|Error)\b(?::|\s|$)/,
  /\bTraceback \(most recent call last\):/,
  /^\s*Caused by:/,
  /\[ERROR\]/,
  /\bERR!\b/,
  /\bFailed to\b/i,
  /\bUnhandledPromiseRejection\b/,
  /\bEADDRINUSE\b/,
  /\bECONNREFUSED\b/
];

const WARN_PATTERNS = [
  /\b(WARN|WARNING)\b/,
  /\[WARNING\]/,
  /\bDEPRECATION\b/i
];

const DEBUG_PATTERNS = [/\b(DEBUG|TRACE)\b/];

const STACK_CONTINUATION_PATTERNS = [
  /^\s+at\s+/,
  /^\s+\.\.\.\s+\d+\s+more\b/,
  /^\s*Caused by:/,
  /^\s*Suppressed:/,
  /^\s+File\s+"[^"]+",\s+line\s+\d+/,
  /^\s+\^+\s*$/,
  /^\s+node:internal\//,
  /^\s+\|\s+/
];

export function classifyLogLevel(
  raw: string,
  stream: 'stdout' | 'stderr' | 'system'
): LogLevel {
  if (stream === 'system') return 'system';
  for (const re of ERROR_PATTERNS) {
    if (re.test(raw)) return 'error';
  }
  for (const re of WARN_PATTERNS) {
    if (re.test(raw)) return 'warn';
  }
  for (const re of DEBUG_PATTERNS) {
    if (re.test(raw)) return 'debug';
  }
  if (stream === 'stderr') {
    // Many Java/Maven/Gradle/Node tools print INFO banners to stderr;
    // treat plain stderr as error only when not explicitly INFO.
    if (/\bINFO\b/.test(raw)) return 'info';
    return 'error';
  }
  return 'info';
}

export function isStackTraceContinuation(raw: string): boolean {
  return STACK_CONTINUATION_PATTERNS.some((re) => re.test(raw));
}
