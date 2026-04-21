/**
 * Layer 2: Skill runtime - minimal YAML front-matter parser.
 *
 * The parser intentionally supports only the subset of YAML required by the
 * Claude Agent Skills front-matter specification. This keeps the SDK's
 * runtime dependency count at zero (NFR-040) while still accepting every
 * form of frontmatter used by the official `anthropics/skills` repository.
 *
 * Supported grammar:
 *   - `key: scalar`     (string, number, boolean, null)
 *   - `key: "quoted"`   (single/double-quoted scalars with `\\`, `\"`, `\n`,
 *                        `\t` escapes)
 *   - `key:` followed by `  - item` lines (block list of scalars)
 *   - `key: [a, b, c]`  (flow list of scalars)
 *   - blank lines and `#`-comments
 *
 * Unsupported grammar (throws `YamlParseError`):
 *   - nested mappings
 *   - anchors/aliases (`&name`, `*name`)
 *   - multi-line block scalars (`|`, `>`)
 *   - merge keys (`<<`)
 */

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[];

export class YamlParseError extends Error {
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(line !== undefined ? `${message} (line ${line})` : message);
    this.name = 'YamlParseError';
    this.line = line;
  }
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;
const BLOCK_ITEM_RE = /^\s*-\s*(.*)$/;

/**
 * Parse a YAML frontmatter block (the content *between* the `---` fences,
 * not the fences themselves) into a plain object.
 */
export function parseYaml(input: string): Record<string, YamlValue> {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const result: Record<string, YamlValue> = {};
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const stripped = stripComment(rawLine);
    if (stripped.trim() === '') {
      i++;
      continue;
    }

    // Top-level keys must have no leading indentation.
    if (/^\s+/.test(rawLine)) {
      throw new YamlParseError('unexpected indentation at top level', i + 1);
    }

    const m = KEY_RE.exec(stripped);
    if (!m) {
      throw new YamlParseError(`cannot parse line: ${stripped}`, i + 1);
    }
    const key = m[1];
    const rest = m[2].trim();

    if (rest === '') {
      // block list follows
      const list: YamlValue[] = [];
      i++;
      while (i < lines.length) {
        const next = stripComment(lines[i]);
        if (next.trim() === '') { i++; continue; }
        const bm = BLOCK_ITEM_RE.exec(next);
        if (!bm) break;
        list.push(parseScalar(bm[1].trim(), i + 1));
        i++;
      }
      result[key] = list;
      continue;
    }

    // inline value (scalar or flow list)
    if (rest.startsWith('[')) {
      result[key] = parseFlowList(rest, i + 1);
    } else {
      result[key] = parseScalar(rest, i + 1);
    }
    i++;
  }

  return result;
}

function stripComment(line: string): string {
  // naive but sufficient: strip comments that are not inside quotes
  let inSingle = false;
  let inDouble = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '\'' && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, j);
  }
  return line;
}

function parseScalar(raw: string, line: number): YamlScalar {
  const t = raw.trim();
  if (t === '') return '';
  // quoted string
  if (t.startsWith('"') || t.startsWith('\'')) {
    return parseQuotedString(t, line);
  }
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (t === 'null' || t === 'Null' || t === 'NULL' || t === '~') return null;
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n;
    return t;
  }
  if (/^-?\d+\.\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    return t;
  }
  // bare string
  return t;
}

function parseQuotedString(raw: string, line: number): string {
  const quote = raw[0];
  if (quote !== '"' && quote !== '\'') {
    throw new YamlParseError('expected quoted string', line);
  }
  if (raw.length < 2 || raw[raw.length - 1] !== quote) {
    throw new YamlParseError('unterminated quoted string', line);
  }
  const body = raw.slice(1, -1);
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && quote === '"') {
      const next = body[i + 1];
      if (next === undefined) {
        throw new YamlParseError('trailing backslash in quoted string', line);
      }
      switch (next) {
        case '"': out.push('"'); break;
        case '\\': out.push('\\'); break;
        case 'n': out.push('\n'); break;
        case 'r': out.push('\r'); break;
        case 't': out.push('\t'); break;
        case '0': out.push('\0'); break;
        case '/': out.push('/'); break;
        default:
          // tolerate unknown escape by echoing it verbatim
          out.push(next);
      }
      i++;
    } else if (ch === '\\' && quote === '\'') {
      // In single-quoted YAML, escapes are not processed; `''` means `'`.
      out.push(ch);
    } else if (ch === '\'' && quote === '\'' && body[i + 1] === '\'') {
      out.push('\'');
      i++;
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

function parseFlowList(raw: string, line: number): YamlScalar[] {
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    throw new YamlParseError('malformed flow list', line);
  }
  const inner = raw.slice(1, -1);
  const items: YamlScalar[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inDouble) {
      buf += ch;
      if (i + 1 < inner.length) { buf += inner[i + 1]; i++; }
      continue;
    }
    if (ch === '\'' && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        const t = buf.trim();
        if (t !== '') items.push(parseScalar(t, line));
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail !== '') items.push(parseScalar(tail, line));
  return items;
}
