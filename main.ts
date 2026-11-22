// main.ts is mend, the CLI SPEC.md specifies: Node 22 and its standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers
// (exact, trailing-whitespace tolerant, indentation-drift tolerant), and writes every
// change or none, printing what it changed or why it failed. SPEC.md is the contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// --- Files, lines and paths (SPEC section 3) ---

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

/** Split a file's text into its lines at its own line break, keeping whether it ends with one. */
function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

/** Join a file model back to text: its break between lines, a final one exactly when it had one. */
function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// --- Matching lines (SPEC section 5) ---

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A line as a tier sees it: tier 0 exact, tier 1 trailing spaces/tabs removed, tier 2 both ends. */
function keyAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndST(line);
  return trimST(line);
}

function matchAt(O: string[], lines: string[], at: number, tier: number): boolean {
  for (let k = 0; k < O.length; k++) {
    if (keyAt(O[k]!, tier) !== keyAt(lines[at + k]!, tier)) return false;
  }
  return true;
}

/** Every 0-based position at or after `from` where O occurs in the file's lines at this tier. */
function occurrences(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    if (matchAt(O, lines, i, tier)) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function firstTierWith(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first tier at which O occurs at or after `from` and ends at the file's last line. */
function firstTierWithEof(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrences(O, lines, t, from).filter((p) => p + O.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
type NPart = { ctx: true; o: number } | { ctx: false; text: string };

/**
 * Build N from its parts: context lines come from the file's matched lines; at tier 2
 * every other line is re-indented, the leading spaces/tabs of O's first line replaced
 * by those of the file's first matched line. At tiers 0 and 1 lines are written as they are.
 */
function buildN(parts: NPart[], O: string[], file: string[], at: number, tier: number): string[] {
  if (tier !== 2 || O.length === 0) {
    return parts.map((p) => (p.ctx ? file[at + p.o]! : p.text));
  }
  const F = leadST(file[at]!);
  const P = leadST(O[0]!);
  return parts.map((p) => {
    if (p.ctx) return file[at + p.o]!;
    const t = p.text;
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(P) ? F + t.slice(P.length) : t;
  });
}

// --- The tree as the edits leave it (SPEC section 10) ---

/** Changed paths in `now` (null: deleted), the rest read from disk; moves recorded for the `R` lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// --- Detecting the format (SPEC section 4) ---

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- JSON edits (SPEC section 9) ---

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const model = splitFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Unified diffs (SPEC section 6) ---

/** One body line of a hunk or a chunk: ' ' context, '-' old, '+' new. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noBreak: boolean;
  /** a `\` line follows the hunk's last `+` line */
  noBreakPlus: boolean;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  plusNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffA: string | undefined;
  diffB: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** The hunk body after the header at lines[i]: body lines, trailing empty lines dropped. */
function parseHunkBody(lines: string[], i: number): { body: BodyLine[]; noBreak: boolean; noBreakPlus: boolean; next: number } {
  const raw: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      // A `--- ` line followed by a `+++ ` line ends the body; it is no old line.
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      raw.push(l);
      j += 1;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const followsBackslash = (k: number): boolean => raw[k + 1] !== undefined && raw[k + 1]!.startsWith('\\');
  let noBreak = false;
  let noBreakPlus = false;
  for (let k = raw.length - 1; k >= 0; k--) {
    if (raw[k]!.startsWith(' ') || raw[k]!.startsWith('+')) {
      noBreak = followsBackslash(k);
      break;
    }
  }
  for (let k = raw.length - 1; k >= 0; k--) {
    if (raw[k]!.startsWith('+')) {
      noBreakPlus = followsBackslash(k);
      break;
    }
  }
  const body: BodyLine[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) continue;
    if (l === '') body.push({ kind: ' ', text: '' });
    else body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
  }
  return { body, noBreak, noBreakPlus, next: j };
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed, a leading a/ or b/ removed; /dev/null means no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  const close = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
    hasPair = false;
  };
  const startSection = (s: Section): void => {
    close();
    cur = s;
    inHeader = true;
  };
  const blankSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    plusNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffA: undefined,
    diffB: undefined,
    isNew: false,
    isDeleted: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffA = m[1]!;
      s.diffB = m[2]!;
      startSection(s);
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader || hasPair) {
        const s = blankSection();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        startSection(s);
        hasPair = true;
      } else {
        cur!.pairOld = headerPath(line);
        cur!.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
      }
      i += 2;
    } else if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
    } else if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader && cur!.pairNew === undefined && cur!.plusNew === undefined) {
        cur!.plusNew = headerPath(line);
      }
      i += 1;
    } else if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i);
      cur!.hunks.push({ a, body: parsed.body, noBreak: parsed.noBreak, noBreakPlus: parsed.noBreakPlus });
      inHeader = false;
      i = parsed.next;
    } else if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur!.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur!.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur!.isNew = true;
      else if (line.startsWith('deleted file mode')) cur!.isDeleted = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  close();
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const parts: NPart[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        parts.push({ ctx: true, o: O.length });
        O.push(b.text);
      } else if (b.kind === '-') {
        O.push(b.text);
      } else {
        parts.push({ ctx: false, text: b.text });
      }
    }
    if (O.length > 0) {
      const found = firstTierWith(O, model.lines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + O.length === model.lines.length;
      const N = buildN(parts, O, model.lines, best, found.tier);
      model.lines.splice(best, O.length, ...N);
      if (atEnd) model.final = !h.noBreak;
      d += N.length - O.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const atEnd = ins === model.lines.length;
      const N = parts.map((p) => (p.ctx ? '' : p.text));
      model.lines.splice(ins, 0, ...N);
      if (atEnd) model.final = !h.noBreak;
      d += N.length;
    }
  }
  return joinFile(model);
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffA;
  const newP =
    sec.pairNew !== undefined ? sec.pairNew : sec.plusNew !== undefined ? sec.plusNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffB;
  return (tree) => {
    if (oldP !== undefined && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== undefined && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || sec.isNew) {
      // Creation: the new path does not exist; the file is the `+` lines of all its hunks.
      if (newP === undefined || newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const b of h.body) {
          if (b.kind === '+') {
            plus.push(b.text);
            hasPlus = true;
          }
        }
        if (hasPlus) noBreak = h.noBreakPlus;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (newP === null || sec.isDeleted) {
      // Deletion: the old path exists; it is deleted, and its hunks are not read.
      if (oldP === undefined || oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === undefined || newP === undefined || oldP === null || newP === null) return;
    const isMove = oldP !== newP;
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const text = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// --- SEARCH/REPLACE blocks (SPEC section 7) ---

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======' && eq === -1) eq = j;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1 || rep < eq) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = splitFile(cur);
    const found = firstTierWith(oldLines, model.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const parts: NPart[] = newLines.map((text) => ({ ctx: false, text }));
    const N = buildN(parts, oldLines, model.lines, at, found.tier);
    model.lines.splice(at, oldLines.length, ...N);
    tree.now.set(path, joinFile(model));
  };
}

// --- V4A patches (SPEC section 8) ---

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${last + 2}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i;
    i += 1;
    const content: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push({ text: l, num: i + 1 });
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text === '') fileLines.push('');
        else if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else throw new Exit2(`error: parse ${c.num}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.num}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
        moveTo = content[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let eofClosed = false;
      for (; idx < content.length; idx++) {
        const c = content[idx]!;
        const l = c.text;
        if (l.startsWith('@@')) {
          curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(curChunk);
          eofClosed = false;
        } else if (l.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${c.num}`);
          curChunk.eof = true;
          eofClosed = true;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (chunks.length === 0) {
              curChunk = { anchor: null, eof: false, body: [] };
              chunks.push(curChunk);
            } else {
              throw new Exit2(`error: parse ${c.num}`);
            }
          } else if (eofClosed) {
            throw new Exit2(`error: parse ${c.num}`);
          }
          curChunk.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${c.num}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = firstTierWith([ch.anchor], model.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const O: string[] = [];
      const parts: NPart[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ') {
          parts.push({ ctx: true, o: O.length });
          O.push(b.text);
        } else if (b.kind === '-') {
          O.push(b.text);
        } else {
          parts.push({ ctx: false, text: b.text });
        }
      }
      if (O.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const N = parts.map((p) => (p.ctx ? '' : p.text));
        model.lines.splice(at, 0, ...N);
        cursor = at + N.length;
      } else {
        const found = ch.eof
          ? firstTierWithEof(O, model.lines, strict, cursor)
          : firstTierWith(O, model.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        const at = found.pos[0]!;
        const N = buildN(parts, O, model.lines, at, found.tier);
        model.lines.splice(at, O.length, ...N);
        cursor = at + N.length;
      }
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// --- Invocation, output and exit codes (SPEC sections 1, 2 and 10) ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // A move that succeeded prints one `R <old> -> <new>` line, replacing that pair's
  // `D` and `A` lines, and sorts by `<new>`; every other change prints `A`, `D` or `M`.
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!moved.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
