/**
 * highlight.ts — dependency-free, streaming-safe syntax highlighter.
 *
 * Design goals (a coding-agent chat client re-highlights on every token):
 *  - zero dependencies, no worker, no async API
 *  - one single-pass scanner per language family, O(n) over the input
 *  - allocation-light: tokens are flat `{ kind, text }` objects and the whole
 *    input is always covered exactly once, so `tokens.map(t => t.text).join('')`
 *    is byte-identical to the input
 *  - malformed / truncated input never throws and never drops text — this is
 *    the normal case while an assistant message streams in
 */

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'class'
  | 'type'
  | 'operator'
  | 'punctuation'
  | 'property'
  | 'variable'
  | 'tag'
  | 'attribute'
  | 'regex'
  | 'deleted'
  | 'inserted'

export interface Token {
  kind: TokenKind
  text: string
}

export type Language =
  | 'ts'
  | 'tsx'
  | 'js'
  | 'jsx'
  | 'json'
  | 'python'
  | 'bash'
  | 'powershell'
  | 'css'
  | 'html'
  | 'yaml'
  | 'toml'
  | 'sql'
  | 'rust'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp'
  | 'markdown'
  | 'diff'
  | 'text'

/* ------------------------------------------------------------------ *
 * Keywords / builtins
 * ------------------------------------------------------------------ */

const CLikeKeywords =
  'abstract as async await base break case catch class const constexpr continue debugger decltype default defer delete do dyn else enum event export extends extern final finally fn for foreach from function get go goto if impl import in instanceof interface internal is isize let lock match mod move mut namespace native new operator out override package params private protected pub public readonly ref return sealed select self set sizeof static struct super switch synchronized this throw throws trait try type typeof unchecked union unsafe unsigned use using var virtual void volatile where while with yield'.split(
    ' ',
  )

const CLikeTypes =
  'any bigint boolean byte char double f32 f64 float i8 i16 i32 i64 i128 int int8 int16 int32 int64 integer long never number object ptr short size_t str string symbol u8 u16 u32 u64 u128 uint uint8 uint16 uint32 uint64 usize unknown usize void'.split(
    ' ',
  )

const CLikeBuiltins =
  'Array Boolean Date Error JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet console document globalThis parseFloat parseInt queueMicrotask structuredClone undefined window'.split(
    ' ',
  )

const TSKeywordSet = new Set<string>(CLikeKeywords)
const TSTypeSet = new Set<string>(CLikeTypes)
const TSBuiltinSet = new Set<string>([...CLikeBuiltins, 'true', 'false', 'null'])

const PythonKeywords = new Set(
  'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield'.split(
    ' ',
  ),
)

const PythonBuiltins = new Set(
  'abs all any bool bytes callable chr dict dir enumerate eval filter float format frozenset getattr hasattr hash hex id input int isinstance issubclass iter len list map max min next object open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip self cls None True False NotImplemented Ellipsis __init__ __name__'.split(
    ' ',
  ),
)

const BashKeywords = new Set(
  'if then else elif fi for while until do done case esac function select in return exit local export readonly declare typeset set unset shift source alias eval exec trap break continue'.split(
    ' ',
  ),
)

const BashBuiltins = new Set(
  'cd ls pwd echo printf cat grep sed awk cut sort uniq head tail find xargs tr wc chmod chown mkdir rmdir rm cp mv ln touch git npm pnpm yarn node npx python python3 pip pip3 curl wget docker kubectl make cmake cargo go rustc tsc vite jest pytest touch sudo apt brew systemctl tar gzip unzip ssh scp rsync diff tree which env'.split(
    ' ',
  ),
)

const PowerShellKeywords = new Set(
  'if else elseif foreach for while do switch function filter param return break continue try catch finally throw begin process end trap class enum in'.split(
    ' ',
  ),
)

const PowerShellCmdlets = new Set(
  'Get-Item Get-ChildItem Get-Content Set-Content Add-Content Remove-Item New-Item Copy-Item Move-Item Test-Path Join-Path Split-Path Resolve-Path Select-Object Where-Object ForEach-Object Sort-Object Group-Object Measure-Object Out-File Out-String Write-Host Write-Output Write-Error Get-Command Invoke-Expression Invoke-WebRequest Start-Process Stop-Process Get-Process New-Object Add-Type Select-String ConvertFrom-Json ConvertTo-Json Get-Content Set-Location Get-Location Get-Date Get-Member Get-Help'.split(
    ' ',
  ),
)

const SqlKeywords = new Set(
  'ADD ALL ALTER AND ANY AS ASC BEGIN BETWEEN BY CASE CAST CHECK COLUMN COMMIT CONSTRAINT CREATE CROSS DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXISTS FOREIGN FROM FULL GROUP HAVING IF IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RIGHT ROLLBACK ROW SELECT SET TABLE THEN TOP TRANSACTION TRUNCATE UNION UNIQUE UPDATE VALUES VIEW WHEN WHERE WITH'.split(
    ' ',
  ),
)

const Pow2 = 4096

/* ------------------------------------------------------------------ *
 * Small scanning helpers (all pure, no state outside the args)
 * ------------------------------------------------------------------ */

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

function isHex(c: number): boolean {
  return isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
}

function pad4(n: number): string {
  return n < Pow2 ? String.fromCharCode(n) : String(n)
}

/** Push a non-empty token when the position advanced. Both pairs are padded. */
function tk(tokens: Token[], kind: TokenKind, end: number, start: number, code: string): void {
  const a = pad4(start)
  const b = pad4(end)
  if (a === b) return
  tokens.push({ kind, text: code.slice(start, end) })
}

/**
 * C-like operator/punctuation scan. Returns the token length, 0 when the char
 * is not an operator at all, or -1 when it is a bare punctuation char.
 */
function scanOp(code: string, i: number): number {
  const c = code[i]
  if (c === '/' && code[i + 1] === '/') return 0
  if (c === '/' && code[i + 1] === '*') return 0
  const three = code.substr(i, 3)
  if (three === '===' || three === '!==' || three === '**=' || three === '...' || three === '??=') return 3
  const two = code.substr(i, 2)
  switch (two) {
    case '=>':
    case '==':
    case '!=':
    case '<=':
    case '>=':
    case '&&':
    case '||':
    case '??':
    case '?.': // also the start of an optional-chain
    case '++':
    case '--':
    case '+=':
    case '-=':
    case '*=':
    case '/=':
    case '%=':
    case '**':
    case '<<':
    case '>>':
    case '->':
    case '::':
    case '..':
    case '|>':
    case '?:':
      return 2
    default:
      break
  }
  switch (c) {
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
    case '=':
    case '<':
    case '>':
    case '!':
    case '&':
    case '|':
    case '^':
    case '~':
    case '?':
    case '@':
      return 1
    case '(':
    case ')':
    case '{':
    case '}':
    case '[':
    case ']':
    case ';':
    case ',':
    case '.':
    case ':':
    case '#':
      return -1
    default:
      return 0
  }
}

/* ------------------------------------------------------------------ *
 * String / number scanners — shared by the C-like and config families
 * ------------------------------------------------------------------ */

/** Quoted string body: starts at the opening quote, ends after the closing one. */
function scanQuoted(code: string, q: number): number {
  const quote = code[q]
  let i = q + 1
  const n = code.length
  while (i < n) {
    if (code[i] === '\\') {
      i += 2
      continue
    }
    if (code[i] === quote) return i + 1
    i += 1
  }
  // Unterminated string (the streaming case): keep the rest as a string token.
  return n
}

/** Backtick template literal, including `${…}` nesting. */
function scanTemplate(code: string, q: number): number {
  let i = q + 1
  const n = code.length
  while (i < n) {
    const ch = code[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') return i + 1
    if (ch === '$' && code[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        const c = code[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '{') depth += 1
        else if (c === '}') depth -= 1
        i += 1
      }
      continue
    }
    i += 1
  }
  return n
}

/** Comment body: starts at `/`, ends after the terminator (or at EOF). */
function scanBlockComment(code: string, i: number): number {
  const n = code.length
  let j = i + 2
  while (j < n) {
    if (code[j] === '*' && code[j + 1] === '/') return j + 2
    j += 1
  }
  return n
}

/** Number body: starts at the first digit / dot, stops at the first non-number. */
function scanNumber(code: string, i: number): number {
  let j = i
  const n = code.length
  // radix prefixes
  if (code[j] === '0' && j + 1 < n && 'xXbBoO'.includes(code[j + 1])) {
    j += 2
    while (j < n && (isHex(code.charCodeAt(j)) || code[j] === '_')) j += 1
    return j
  }
  while (j < n && (isDigit(code.charCodeAt(j)) || code[j] === '_' || code[j] === '.')) j += 1
  if (j < n && 'eE'.includes(code[j])) {
    j += 1
    if (j < n && (code[j] === '+' || code[j] === '-')) j += 1
    while (j < n && isDigit(code.charCodeAt(j))) j += 1
  }
  if (j < n && 'nNfFdDlLuU'.includes(code[j])) j += 1
  if (j < n && code[j] === 'u' && code[j + 1] === 'l') j += 2
  return j
}

/** Regex literal body: starts at `/`, ends after `/[flags]` (line-scoped). */
function scanRegex(code: string, i: number): number {
  const n = code.length
  let j = i + 1
  let inClass = false
  while (j < n) {
    const c = code[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n') return -1 // regex literals cannot span lines
    if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') {
      inClass = true
    } else if (c === '/') {
      j += 1
      while (j < n && /[a-z]/i.test(code[j])) j += 1
      return j
    }
    j += 1
  }
  return -1
}

/** True for chars that may open an identifier. */
function isIdentStart(code: string, i: number): boolean {
  const c = code.charCodeAt(i)
  if (isDigit(c)) return false
  if (c >= 97 && c <= 122) return true // a-z
  if (c >= 65 && c <= 90) return true // A-Z
  const ch = code[i]
  return ch === '_' || ch === '$' || ch === '\\' || ch.charCodeAt(0) > 127
}

function isIdentPart(code: string, i: number): boolean {
  const c = code.charCodeAt(i)
  if (isDigit(c)) return true
  const ch = code[i]
  return (
    c === 95 ||
    ch === '$' ||
    ch === '-' || // css custom properties / yaml-ish keys
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    c > 127
  )
}

/* ------------------------------------------------------------------ *
 * C-like family: ts/tsx/js/jsx/java/go/rust/c/cpp/css/sql/json
 * ------------------------------------------------------------------ */

type CLikeFlavor = 'js' | 'ts' | 'css' | 'sql' | 'json' | 'type'

const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'do',
  'else',
  'try',
  'finally',
  'return',
  'typeof',
  'instanceof',
])

function cLikeFlavor(language: Language): CLikeFlavor {
  switch (language) {
    case 'ts':
    case 'tsx':
      return 'ts'
    case 'js':
    case 'jsx':
      return 'js'
    case 'css':
      return 'css'
    case 'sql':
      return 'sql'
    case 'json':
      return 'json'
    default:
      return 'type'
  }
}

function keywordKind(word: string, flavor: CLikeFlavor): TokenKind | null {
  switch (flavor) {
    case 'js':
    case 'ts':
      if (word === 'true' || word === 'false' || word === 'null' || word === 'undefined')
        return 'keyword'
      if (TSKeywordSet.has(word)) return 'keyword'
      if (TSTypeSet.has(word)) return 'type'
      if (TSBuiltinSet.has(word)) return 'type'
      return null
    case 'type':
      if (CLikeTypes.includes(word)) return 'type'
      if (CLikeKeywords.includes(word)) return 'keyword'
      return null
    case 'sql':
      return SqlKeywords.has(word.toUpperCase()) ? 'keyword' : null
    case 'json':
      if (word === 'true' || word === 'false' || word === 'null') return 'keyword'
      return null
    case 'css':
      return null
    default:
      return null
  }
}

function tokenizeCLike(code: string, flavor: CLikeFlavor): Token[] {
  const tokens: Token[] = []
  const n = code.length
  let i = 0
  let expectProperty = false

  while (i < n) {
    const c = code[i]

    /* whitespace -------------------------------------------------- */
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1
      while (j < n) {
        const w = code[j]
        if (w === ' ' || w === '\t' || w === '\n' || w === '\r') j += 1
        else break
      }
      tk(tokens, 'plain', j, i, code)
      i = j
      continue
    }

    /* comments ---------------------------------------------------- */
    if (c === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = scanBlockComment(code, i)
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }
    if (flavor === 'sql' && c === '-' && code[i + 1] === '-') {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }
    if (flavor === 'sql' && c === '#') {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }

    /* strings ----------------------------------------------------- */
    if (c === '"' || c === "'") {
      const end = scanQuoted(code, i)
      if (flavor === 'css' && code[end] === ':') {
        tk(tokens, 'property', end, i, code)
      } else {
        tk(tokens, 'string', end, i, code)
      }
      i = end
      continue
    }
    if (c === '`' && (flavor === 'js' || flavor === 'ts')) {
      const end = scanTemplate(code, i)
      tk(tokens, 'string', end, i, code)
      i = end
      continue
    }

    /* numbers (a leading dot counts when followed by a digit) ------ */
    if (isDigit(code.charCodeAt(i)) || (c === '.' && isDigit(code.charCodeAt(i + 1)))) {
      const end = scanNumber(code, i)
      tk(tokens, 'number', end, i, code)
      i = end
      continue
    }

    /* regex literals (js/ts only, best effort) --------------------- */
    if (c === '/' && (flavor === 'js' || flavor === 'ts') && canStartRegex(tokens)) {
      const end = scanRegex(code, i)
      if (end > 0) {
        tk(tokens, 'regex', end, i, code)
        i = end
        continue
      }
    }

    /* css at-rules ------------------------------------------------ */
    if (flavor === 'css' && c === '@') {
      let j = i + 1
      while (j < n && (isIdentPart(code, j) || code[j] === '-')) j += 1
      tk(tokens, 'keyword', j, i, code)
      i = j
      continue
    }

    /* identifiers ------------------------------------------------- */
    if (isIdentStart(code, i)) {
      let j = i + 1
      while (j < n && isIdentPart(code, j)) j += 1
      const word = code.slice(i, j)

      if (flavor === 'sql') {
        const upper = word.toUpperCase()
        tk(tokens, SqlKeywords.has(upper) ? 'keyword' : 'plain', j, i, code)
        i = j
        continue
      }

      let k = j
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k += 1
      const next = code[k]

      let kind: TokenKind
      if (flavor === 'json') {
        kind = next === ':' ? 'property' : 'plain'
      } else if (flavor === 'css') {
        kind = next === ':' && expectProperty ? 'property' : 'plain'
      } else if (expectProperty && next === ':') {
        kind = 'property'
      } else {
        kind = keywordKind(word, flavor) ?? (next === '(' ? 'function' : 'plain')
      }

      if (flavor === 'css' && kind === 'property') expectProperty = false
      tk(tokens, kind, j, i, code)
      i = j
      continue
    }

    /* operators / punctuation -------------------------------------- */
    const op = scanOp(code, i)
    if (op === -1) {
      tk(tokens, 'punctuation', i + 1, i, code)
      i += 1
      expectProperty = c === '{' || c === ';' || c === ','
      continue
    }
    if (op > 0) {
      tk(tokens, 'operator', i + op, i, code)
      i += op
      expectProperty = false
      continue
    }

    tk(tokens, 'plain', i + 1, i, code)
    i += 1
  }

  return tokens
}

/** Heuristic: can a `/` at this point be a regex literal rather than division? */
function canStartRegex(tokens: Token[]): boolean {
  for (let k = tokens.length - 1; k >= 0; k -= 1) {
    const t = tokens[k]
    if (t.kind === 'plain' && /^\s*$/.test(t.text)) continue
    switch (t.kind) {
      case 'keyword':
        return CONTROL_KEYWORDS.has(t.text)
      case 'operator':
      case 'punctuation':
        return !(t.text === ')' || t.text === ']' || t.text === '}')
      case 'number':
      case 'string':
      case 'variable':
        return false
      case 'class':
        return true
      default:
        return false
    }
  }
  return true
}

/* ------------------------------------------------------------------ *
 * Python
 * ------------------------------------------------------------------ */

function tokenizePython(code: string): Token[] {
  const tokens: Token[] = []
  const n = code.length
  let i = 0
  let atLineStart = true

  while (i < n) {
    const c = code[i]

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1
      while (j < n) {
        const w = code[j]
        if (w === ' ' || w === '\t' || w === '\n' || w === '\r') j += 1
        else break
      }
      tk(tokens, 'plain', j, i, code)
      i = j
      continue
    }

    if (c === '#') {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }

    // Triple-quoted strings (also the unfinished streaming case).
    if ((c === '"' || c === "'") && code[i + 1] === c && code[i + 2] === c) {
      const close = code.indexOf(c + c + c, i + 3)
      const end = close === -1 ? n : close + 3
      tk(tokens, 'string', end, i, code)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      const end = scanQuoted(code, i)
      tk(tokens, 'string', end, i, code)
      i = end
      continue
    }

    // Decorators
    if (c === '@' && atLineStart) {
      let j = i + 1
      while (j < n && (isIdentPart(code, j) || code[j] === '.')) j += 1
      tk(tokens, 'class', j, i, code)
      i = j
      continue
    }

    if (isDigit(code.charCodeAt(i)) || (c === '.' && isDigit(code.charCodeAt(i + 1)))) {
      const end = scanNumber(code, i)
      tk(tokens, 'number', end, i, code)
      i = end
      continue
    }

    if (isIdentStart(code, i)) {
      let j = i + 1
      while (j < n && isIdentPart(code, j)) j += 1
      const word = code.slice(i, j)
      const prev = lastSignificant(tokens)
      let kind: TokenKind
      if (word === 'self' || word === 'cls') {
        kind = 'variable'
      } else if (prev === 'def') {
        kind = 'function'
      } else if (prev === 'class') {
        kind = 'class'
      } else if (PythonKeywords.has(word)) {
        kind = 'keyword'
      } else if (PythonBuiltins.has(word)) {
        if (word === 'None' || word === 'True' || word === 'False') kind = 'keyword'
        else if (word === 'self' || word === 'cls') kind = 'variable'
        else kind = 'type'
      } else {
        let k = j
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k += 1
        kind = code[k] === '(' ? 'function' : 'plain'
      }
      tk(tokens, kind, j, i, code)
      i = j
      atLineStart = false
      continue
    }

    const op = scanOp(code, i)
    if (op === -1) {
      tk(tokens, 'punctuation', i + 1, i, code)
      i += 1
      continue
    }
    if (op > 0) {
      tk(tokens, 'operator', i + op, i, code)
      i += op
      continue
    }

    tk(tokens, 'plain', i + 1, i, code)
    i += 1
  }

  return tokens
}

/** Text of the previous non-whitespace token, or null. */
function lastSignificant(tokens: Token[]): string | null {
  for (let k = tokens.length - 1; k >= 0; k -= 1) {
    const t = tokens[k]
    if (t.kind === 'plain' && /^\s*$/.test(t.text)) continue
    return t.text
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Shell: bash + powershell
 * ------------------------------------------------------------------ */

function tokenizeShell(code: string, flavor: 'bash' | 'powershell'): Token[] {
  const tokens: Token[] = []
  const n = code.length
  let i = 0

  while (i < n) {
    const c = code[i]

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1
      while (j < n) {
        const w = code[j]
        if (w === ' ' || w === '\t' || w === '\n' || w === '\r') j += 1
        else break
      }
      tk(tokens, 'plain', j, i, code)
      i = j
      continue
    }

    if (flavor === 'bash') {
      if (c === '#') {
        const nl = code.indexOf('\n', i)
        const end = nl === -1 ? n : nl
        tk(tokens, 'comment', end, i, code)
        i = end
        continue
      }
      if (c === '"' || c === "'") {
        const end = scanQuoted(code, i)
        tk(tokens, 'string', end, i, code)
        i = end
        continue
      }
    } else {
      if (c === '<' && code[i + 1] === '#') {
        const close = code.indexOf('#>', i + 2)
        const end = close === -1 ? n : close + 2
        tk(tokens, 'comment', end, i, code)
        i = end
        continue
      }
      if (c === '<' && code[i + 1] === '<') {
        // here-string: @" … "@ / @' … '@
        const q = code[i + 2]
        if (q === '"' || q === "'") {
          const term = q + '@'
          const close = code.indexOf(term, i + 3)
          const end = close === -1 ? n : close + 2
          tk(tokens, 'string', end, i, code)
          i = end
          continue
        }
      }
      if (c === '"' || c === "'") {
        const end = scanQuoted(code, i)
        tk(tokens, 'string', end, i, code)
        i = end
        continue
      }
      // `$env:VAR` / `$Var`
      if (c === '$') {
        let j = i + 1
        while (j < n && isIdentPart(code, j)) j += 1
        if (code[j] === ':') {
          j += 1
          while (j < n && isIdentPart(code, j)) j += 1
        }
        if (j > i + 1) {
          tk(tokens, 'variable', j, i, code)
          i = j
          continue
        }
      }
      // -Parameter / -Flag
      if (c === '-' && isIdentStart(code, i + 1)) {
        let j = i + 1
        while (j < n && (isIdentPart(code, j) || code[j] === '-')) j += 1
        tk(tokens, 'variable', j, i, code)
        i = j
        continue
      }
    }

    if (c === '$' && flavor === 'bash') {
      let j = i + 1
      if (code[j] === '{') {
        const close = code.indexOf('}', j)
        j = close === -1 ? n : close + 1
      } else {
        while (j < n && isIdentPart(code, j)) j += 1
      }
      if (j > i + 1) {
        tk(tokens, 'variable', j, i, code)
        i = j
        continue
      }
    }

    if (isDigit(code.charCodeAt(i))) {
      const end = scanNumber(code, i)
      tk(tokens, 'number', end, i, code)
      i = end
      continue
    }

    if (isIdentStart(code, i)) {
      let j = i + 1
      while (j < n && (isIdentPart(code, j) || (flavor === 'bash' && code[j] === '.'))) j += 1
      const word = code.slice(i, j)
      const set = flavor === 'bash' ? BashKeywords : PowerShellKeywords
      let kind: TokenKind
      if (set.has(word)) kind = 'keyword'
      else if (flavor === 'bash' && BashBuiltins.has(word)) kind = 'function'
      else if (flavor === 'powershell' && PowerShellCmdlets.has(word)) kind = 'function'
      else kind = 'plain'
      if (flavor === 'bash' && code[j] === '=' && code[j + 1] !== '=') kind = 'variable'
      tk(tokens, kind, j, i, code)
      i = j
      continue
    }

    const op = scanOp(code, i)
    if (op === -1) {
      tk(tokens, 'punctuation', i + 1, i, code)
      i += 1
      continue
    }
    if (op > 0) {
      tk(tokens, 'operator', i + op, i, code)
      i += op
      continue
    }

    tk(tokens, 'plain', i + 1, i, code)
    i += 1
  }

  return tokens
}

/* ------------------------------------------------------------------ *
 * Markup: html (+ embedded <script>/<style>)
 * ------------------------------------------------------------------ */

function tokenizeMarkup(code: string): Token[] {
  const tokens: Token[] = []
  const n = code.length
  let i = 0

  while (i < n) {
    const lt = code.indexOf('<', i)

    /* text run ----------------------------------------------------- */
    if (lt === -1) {
      tk(tokens, 'plain', n, i, code)
      break
    }
    if (lt > i) tk(tokens, 'plain', lt, i, code)
    i = lt

    /* comment ------------------------------------------------------ */
    if (code.startsWith('<!--', i)) {
      const close = code.indexOf('-->', i + 4)
      const end = close === -1 ? n : close + 3
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }

    /* doctype / declaration ---------------------------------------- */
    if (code[i + 1] === '!' || code[i + 1] === '?') {
      const close = code.indexOf('>', i)
      const end = close === -1 ? n : close + 1
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }

    /* closing tag -------------------------------------------------- */
    if (code[i + 1] === '/') {
      let j = i + 2
      while (j < n && /[a-zA-Z0-9:_-]/.test(code[j])) j += 1
      tk(tokens, 'tag', j, i, code)
      const gt = code.indexOf('>', j)
      const end = gt === -1 ? n : gt + 1
      tk(tokens, 'punctuation', end, j, code)
      i = end
      continue
    }

    /* opening tag (+ attributes) ----------------------------------- */
    if (/[a-zA-Z]/.test(code[i + 1] ?? '')) {
      let j = i + 1
      while (j < n && /[a-zA-Z0-9:_-]/.test(code[j])) j += 1
      const tag = code.slice(i + 1, j).toLowerCase()
      tk(tokens, 'tag', j, i, code)

      let closed = false
      while (j < n) {
        const cj = code[j]
        if (cj === '>') {
          tk(tokens, 'punctuation', j + 1, j, code)
          j += 1
          closed = true
          break
        }
        if (cj === '"' || cj === "'") {
          const end = scanQuoted(code, j)
          tk(tokens, 'string', end, j, code)
          j = end
          continue
        }
        if (cj === '=') {
          tk(tokens, 'operator', j + 1, j, code)
          j += 1
          continue
        }
        if (isIdentStart(code, j) || cj === ':' || cj === '@') {
          let k = j + 1
          while (k < n && (isIdentPart(code, k) || code[k] === ':' || code[k] === '@' || code[k] === '.'))
            k += 1
          tk(tokens, 'attribute', k, j, code)
          j = k
          continue
        }
        tk(tokens, 'plain', j + 1, j, code)
        j += 1
      }

      if (closed && (tag === 'script' || tag === 'style')) {
        const closeAt = code.toLowerCase().indexOf(`</${tag}`, j)
        const inner = closeAt === -1 ? n : closeAt
        if (inner > j) {
          const innerTokens = tag === 'script' ? tokenizeCLike(code.slice(j, inner), 'js') : tokenizeCLike(code.slice(j, inner), 'css')
          for (const t of innerTokens) tokens.push(t)
        }
        i = inner
        continue
      }

      if (!closed) break
      i = j
      continue
    }

    /* a stray `<` — just text -------------------------------------- */
    tk(tokens, 'plain', i + 1, i, code)
    i += 1
  }

  return tokens
}

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

const DIFF_FILE_RE = /^diff --git |^index [0-9a-f]{4,}|^--- |^\+\+\+ |^new file mode |^deleted file mode /

function concat(a: Token[], b: Token[]): Token[] {
  for (let i = 0; i < b.length; i += 1) a.push(b[i])
  return a
}

/**
 * Detect the language a diff is about — from the `--- a/x.py` header when it
 * has a useful extension, otherwise from the first added line's shape.
 */
function detectDiffLanguage(code: string): Language {
  const header = /^(?:\+\+\+|---)\s+\S*?\.([A-Za-z0-9]+)/m.exec(code)
  if (header) {
    const fromExt = detectLanguage('', header[1])
    if (fromExt !== 'text') return fromExt
  }
  let body = ''
  const lines = code.split('\n')
  for (let i = 0; i < lines.length && i < 60; i += 1) {
    const line = lines[i]
    if (line[0] === '+') body += `${line.slice(1)}\n`
  }
  if (body) {
    const guessed = detectLanguage('', body)
    if (guessed !== 'text') return guessed
  }
  return 'text'
}

function tokenizeDiff(code: string, inner: Language): Token[] {
  const tokens: Token[] = []
  const lines = code.split('\n')

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]
    const first = line[0]
    const isHeader = DIFF_FILE_RE.test(line)
    const isHunk = first === '@' && line.startsWith('@@')

    if (isHeader || isHunk) {
      tokens.push({ kind: 'plain', text: line })
    } else if (first === '+') {
      tokens.push({ kind: 'inserted', text: '+' })
      concat(tokens, singleLineTokens(line.slice(1), inner))
    } else if (first === '-') {
      tokens.push({ kind: 'deleted', text: '-' })
      concat(tokens, singleLineTokens(line.slice(1), inner))
    } else if (line.length > 0) {
      tokens.push({ kind: 'plain', text: line })
    }

    if (li < lines.length - 1) tokens.push({ kind: 'plain', text: '\n' })
  }

  if (tokens.length === 0) tokens.push({ kind: 'plain', text: code })
  return tokens
}

/** Tokenize one line of diff content with the inner language (cheap path). */
function singleLineTokens(text: string, inner: Language): Token[] {
  if (!inner || inner === 'text' || inner === 'diff') return text ? [{ kind: 'plain', text }] : []
  return tokenize(text, inner)
}

/**
 * Fast path for rendering a single line of a live diff. Returns the token kind
 * for the whole line, or null when the line carries no diff semantics and the
 * caller should tokenize it normally.
 */
export function classifyLine(language: Language, line: string): TokenKind | null {
  if (language === 'diff') {
    if (DIFF_FILE_RE.test(line)) return 'plain'
    if (line.startsWith('@@')) return 'plain'
    if (line.startsWith('+++') || line.startsWith('---')) return line.startsWith('+') ? 'inserted' : 'deleted'
    if (line.startsWith('+')) return 'inserted'
    if (line.startsWith('-')) return 'deleted'
    if (line.startsWith('\\')) return 'plain'
    return null
  }
  if (language === 'markdown') {
    if (line.startsWith('#')) return 'keyword'
    if (line.startsWith('>') || line.startsWith('- ') || line.startsWith('* ')) return 'punctuation'
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Config: yaml / toml
 * ------------------------------------------------------------------ */

function tokenizeConfig(code: string, language: 'yaml' | 'toml'): Token[] {
  const tokens: Token[] = []
  const n = code.length
  let i = 0
  let atLineStart = true
  let inValue = false

  while (i < n) {
    const c = code[i]

    if (c === '\n' || c === '\r') {
      tk(tokens, 'plain', i + 1, i, code)
      i += 1
      atLineStart = true
      inValue = false
      continue
    }

    if (c === ' ' || c === '\t') {
      let j = i + 1
      while (j < n && (code[j] === ' ' || code[j] === '\t')) j += 1
      tk(tokens, 'plain', j, i, code)
      i = j
      continue
    }

    if (c === '#') {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      tk(tokens, 'comment', end, i, code)
      i = end
      continue
    }

    if (language === 'toml' && c === '[') {
      const close = code.indexOf(']', i)
      const end = close === -1 ? n : close + 1
      tk(tokens, 'class', end, i, code)
      i = end
      atLineStart = false
      continue
    }

    if (language === 'yaml' && c === '-' && atLineStart && (code[i + 1] === ' ' || code[i + 1] === '\n')) {
      tk(tokens, 'punctuation', i + 1, i, code)
      i += 1
      continue
    }

    if (c === '[' || c === '{') {
      tk(tokens, 'punctuation', i + 1, i, code)
      i += 1
      continue
    }
    if (c === ']' || c === '}') {
      tk(tokens, 'punctuation', i + 1, i, code)
      i += 1
      continue
    }
    if (c === ',') {
      tk(tokens, 'punctuation', i + 1, i, code)
      i += 1
      continue
    }

    /* keys ------------------------------------------------------- */
    if (isIdentStart(code, i) || c === '"' || c === "'") {
      const keyEnd = code[i] === '"' || code[i] === "'" ? scanQuoted(code, i) : scanWordKey(code, i)
      let k = keyEnd
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k += 1
      const next = code[k]
      const isKey = inValue
        ? false
        : next === ':' || next === '=' || (language === 'toml' && next === '.')
      if (isKey) {
        tk(tokens, 'property', keyEnd, i, code)
        i = keyEnd
        atLineStart = false
        continue
      }
    }

    /* scalars ---------------------------------------------------- */
    if (c === '"' || c === "'") {
      const end = scanQuoted(code, i)
      tk(tokens, 'string', end, i, code)
      i = end
      inValue = true
      atLineStart = false
      continue
    }

    // punctuation anchors for blocks
    if (c === ':' || c === '=') {
      tk(tokens, 'operator', i + 1, i, code)
      i += 1
      inValue = true
      atLineStart = false
      continue
    }

    if (c === '|' || c === '>') {
      if (language === 'yaml') {
        tk(tokens, 'operator', i + 1, i, code)
        i += 1
        continue
      }
    }

    /* plain (unquoted) values ----------------------------------- */
    {
      let j = i
      while (j < n && !',]}\n\r'.includes(code[j])) {
        if (code[j] === ' ' || code[j] === '\t') break
        j += 1
      }
      if (j === i) {
        tk(tokens, 'plain', i + 1, i, code)
        i += 1
        continue
      }
      const word = code.slice(i, j)
      const lower = word.toLowerCase()
      let kind: TokenKind = 'plain'
      if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(word) || /^0[xX][0-9a-fA-F_]+$/.test(word)) {
        kind = 'number'
      } else if (lower === 'true' || lower === 'false' || lower === 'null' || lower === '~') {
        kind = 'keyword'
      } else if (word === '&' || word === '*') {
        kind = 'variable'
      }
      tk(tokens, kind, j, i, code)
      i = j
      inValue = true
      atLineStart = false
      continue
    }
  }

  if (tokens.length === 0) tokens.push({ kind: 'plain', text: code })
  return tokens
}

function scanWordKey(code: string, i: number): number {
  let j = i + 1
  while (j < code.length && (isIdentPart(code, j) || code[j] === '.' || code[j] === '-')) j += 1
  return j
}

/* ------------------------------------------------------------------ *
 * Markdown (approximate: block markers + inline `code`)
 * ------------------------------------------------------------------ */

function tokenizeMarkdown(code: string): Token[] {
  const tokens: Token[] = []
  const lines = code.split('\n')
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]
    tokenizeMarkdownLine(tokens, line)
    if (li < lines.length - 1) tokens.push({ kind: 'plain', text: '\n' })
  }
  if (tokens.length === 0) tokens.push({ kind: 'plain', text: code })
  return tokens
}

function tokenizeMarkdownLine(tokens: Token[], line: string): void {
  const heading = /^(#{1,6})(\s+)/.exec(line)
  if (heading) {
    tokens.push({ kind: 'keyword', text: heading[1] })
    tokens.push({ kind: 'plain', text: heading[2] })
    tokenizeInline(tokens, line.slice(heading[0].length))
    return
  }
  const fence = /^(\s*)(```|~~~)(.*)$/.exec(line)
  if (fence) {
    if (fence[1]) tokens.push({ kind: 'plain', text: fence[1] })
    tokens.push({ kind: 'operator', text: fence[2] })
    if (fence[3]) tokens.push({ kind: 'keyword', text: fence[3] })
    return
  }
  const bullet = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line)
  if (bullet) {
    if (bullet[1]) tokens.push({ kind: 'plain', text: bullet[1] })
    tokens.push({ kind: 'punctuation', text: bullet[2] })
    tokens.push({ kind: 'plain', text: bullet[3] })
    tokenizeInline(tokens, line.slice(bullet[0].length))
    return
  }
  const quote = /^(\s*>+\s?)/.exec(line)
  if (quote) {
    tokens.push({ kind: 'punctuation', text: quote[1] })
    tokenizeInline(tokens, line.slice(quote[1].length))
    return
  }
  tokenizeInline(tokens, line)
}

function tokenizeInline(tokens: Token[], text: string): void {
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '`') {
      const close = text.indexOf('`', i + 1)
      const end = close === -1 ? n : close + 1
      tokens.push({ kind: 'string', text: text.slice(i, end) })
      i = end
      continue
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i
      while (j < n && text[j] === c) j += 1
      tokens.push({ kind: 'operator', text: text.slice(i, j) })
      i = j
      continue
    }
    if (c === '[' || c === ']' || c === '(' || c === ')') {
      tokens.push({ kind: 'punctuation', text: c })
      i += 1
      continue
    }
    let j = i + 1
    while (j < n && text[j] !== '`' && text[j] !== '*' && text[j] !== '_' && text[j] !== '~' && text[j] !== '[' && text[j] !== ']' && text[j] !== '(' && text[j] !== ')')
      j += 1
    tokens.push({ kind: 'plain', text: text.slice(i, j) })
    i = j
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export function tokenize(code: string, language: Language): Token[] {
  if (code === '') return []
  try {
    switch (language) {
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
      case 'java':
      case 'go':
      case 'rust':
      case 'c':
      case 'cpp':
      case 'css':
      case 'sql':
      case 'json':
        return tokenizeCLike(code, cLikeFlavor(language))
      case 'python':
        return tokenizePython(code)
      case 'bash':
        return tokenizeShell(code, 'bash')
      case 'powershell':
        return tokenizeShell(code, 'powershell')
      case 'html':
        return tokenizeMarkup(code)
      case 'yaml':
        return tokenizeConfig(code, 'yaml')
      case 'toml':
        return tokenizeConfig(code, 'toml')
      case 'markdown':
        return tokenizeMarkdown(code)
      case 'diff':
        return tokenizeDiff(code, detectDiffLanguage(code))
      default:
        return tokenizePlain(code)
    }
  } catch {
    // Never throw at the renderer: degrade to a single plain token.
    return [{ kind: 'plain', text: code }]
  }
}

function tokenizePlain(code: string): Token[] {
  return [{ kind: 'plain', text: code }]
}

/* ------------------------------------------------------------------ *
 * Language detection
 * ------------------------------------------------------------------ */

const LANGUAGE_ALIASES: Record<string, Language> = {
  ts: 'ts',
  cts: 'ts',
  mts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  js: 'js',
  cjs: 'js',
  mjs: 'js',
  javascript: 'js',
  node: 'js',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  geojson: 'json',
  py: 'python',
  pyi: 'python',
  python: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  fish: 'bash',
  console: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  powershell: 'powershell',
  cmd: 'powershell',
  bat: 'powershell',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  svelte: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'toml',
  sql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  java: 'java',
  kt: 'java',
  kotlin: 'java',
  cs: 'java',
  csharp: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  'c++': 'cpp',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
  text: 'text',
  txt: 'text',
  plaintext: 'text',
  log: 'text',
}

export function detectLanguage(hint?: string | null, code?: string): Language {
  const raw = (hint ?? '').trim().toLowerCase()
  if (raw) {
    const cleaned = raw.replace(/^language-/, '').replace(/^\./, '').split(/[\s:{[]/)[0].trim()
    const known = LANGUAGE_ALIASES[cleaned]
    if (known) return known
  }

  const src = code ?? ''
  if (!src) return 'text'

  // A unified diff is unambiguous once we see a hunk header.
  if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(src) || /^diff --git /m.test(src)) return 'diff'

  const head = src.slice(0, 800)
  const scores: Partial<Record<Language, number>> = {}

  const bump = (language: Language, amount: number): void => {
    scores[language] = (scores[language] ?? 0) + amount
  }

  const mark = (re: RegExp, language: Language, amount = 1): void => {
    const matches = head.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))
    if (matches) bump(language, Math.min(matches.length * amount, amount * 4))
  }

  mark(/^\s*#!\s*\/.*\b(python3?|bash|sh|zsh|pwsh)\b/m, 'python', 1)
  mark(/^\s*#!\s*\/[^\n]*\b(python3?)\b/m, 'python', 4)
  mark(/^\s*#!\s*\/[^\n]*\b(bash|sh|zsh)\b/m, 'bash', 4)

  mark(/^\s*def\s+\w+\s*\(/m, 'python', 3)
  mark(/^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+$)/m, 'python', 2)
  mark(/\bself\b/, 'python', 2)
  mark(/\bNone\b/, 'python', 1)
  mark(/^\s*(class\s+\w+(\(|:)|@\w+)/m, 'python', 1)

  mark(/\b(def|end|do)\b/, 'rust', 1)
  mark(/\bfn\s+\w+/g, 'rust', 3)
  mark(/\b(let\s+mut|impl|pub\s+fn|use\s+std|println!)/g, 'rust', 2)

  mark(/\bfunc\s+\w+/g, 'go', 3)
  mark(/^\s*package\s+\w+/m, 'go', 3)
  mark(/\b(go\s+func|chan\s|defer\s)/g, 'go', 1)

  mark(/\b(interface|implements|extends)\b/g, 'java', 1)
  mark(/\b(public|private|protected)\s+(static\s+)?(final\s+)?\w+\s+\w+\s*[(=;]/g, 'java', 2)
  mark(/^\s*(package|import)\s+[\w.]+;/m, 'java', 2)

  mark(/\b(interface|type)\s+\w+\s*[={]/g, 'ts', 1)
  mark(/:\s*(string|number|boolean|void|unknown|any)\b/g, 'ts', 2)
  mark(/\b(export|import)\s+(type|interface)\b/g, 'ts', 3)
  mark(/\b(const|let|var)\s+\w+\s*[:=]/g, 'js', 1)
  mark(/\b(=>|async\s+function)\b/g, 'js', 1)
  mark(/=>\s*\{/g, 'js', 1)
  mark(/<\/?[A-Za-z][\w-]*(\s|>|\/)/g, 'jsx', 2)

  mark(/^\s*#include\s*[<"]/m, 'c', 6)
  mark(/^\s*#include\s*<(vector|string|iostream|memory|map|algorithm|stdio\.h|stdlib\.h|unistd\.h)>/m, 'cpp', 6)
  mark(/\bstd::/, 'cpp', 5)
  mark(/\b(int|void|char|long)\s+main\s*\(/g, 'c', 5)
  mark(/^\s*#(define|ifndef|pragma\s+once|endif)\b/m, 'c', 2)

  const trimmed = src.trim()
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed) && !/(^|[^:])\/\//.test(trimmed)) {
    try {
      JSON.parse(src)
      return 'json'
    } catch {
      bump('json', 2)
    }
  }

  mark(/^\s*<!DOCTYPE\s+html/mi, 'html', 5)
  mark(/<\/?(html|head|body|div|span|p|a|ul|li|section|main|button)\b/gi, 'html', 2)
  mark(/^\s*<[?]xml/m, 'html', 5)
  mark(/<svg\b/i, 'html', 5)
  mark(/xmlns=(?:"|')http:\/\/www\.w3\.org\/2000\/svg/, 'html', 5)
  mark(/^\s*<(html|head|body)\b/im, 'html', 4)
  mark(/<style\b/i, 'html', 2)

  mark(/^\s*@media\b/m, 'css', 5)
  mark(/^\s*[.#][\w-]+\s*\{/m, 'css', 4)
  mark(/[\w-]+\s*:\s*[^;{\n]+;/g, 'css', 1)

  mark(/^\s*provider\s+"[\w-]+"/m, 'toml', 5)
  mark(/^\s*\[[\w.-]+\]\s*$/m, 'toml', 3)
  mark(/^\s*\w+\s*=\s*.+$/m, 'toml', 1)

  mark(/^\s*---\s*$/m, 'yaml', 1)
  mark(/^\s*[\w.-]+:\s*(\S.*)?$/m, 'yaml', 2)
  mark(/^\s*-\s+\w+:/m, 'yaml', 4)
  mark(/^\s*[A-Za-z_][\w$-]*:\s*$/m, 'yaml', 2)

  mark(/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/mi, 'sql', 2)
  mark(/\b(FROM|WHERE|JOIN)\s+\w+/gi, 'sql', 1)
  mark(/\bCREATE\s+TABLE\b/gi, 'sql', 3)

  mark(/^\s*(function|param)\s*\(/m, 'powershell', 1)
  mark(/\$(env:|\w+)/g, 'powershell', 1)
  mark(/^\s*(cd|export|echo|sudo|apt|npm|pnpm|yarn|git|curl|grep)\s/m, 'bash', 2)
  mark(/^\s*\|\s*\w+/m, 'bash', 1)

  mark(/^\s*[+@]@?@@/m, 'diff', 5)
  mark(/^\s*(#{1,6})\s+\S/m, 'markdown', 2)
  mark(/^\s*```/m, 'markdown', 2)
  mark(/\[[^\]]+\]\([^)]+\)/g, 'markdown', 2)

  let best: Language = 'text'
  let bestScore = 0
  for (const key of Object.keys(scores) as Language[]) {
    const value = scores[key] ?? 0
    if (value > bestScore) {
      best = key
      bestScore = value
    }
  }
  if (bestScore < 3) return 'text'

  // The C-like C family shares its scanner, so the tie-break only decides
  // which keyword table is used. Prefer C++ whenever C++-only syntax appears.
  if (
    best === 'c' &&
    (/std::|#include\s*<(vector|string|iostream|memory|map|algorithm|utility)>|\b(namespace|template|public|private)\b/.test(src) ||
      /\bcout\b|\bcin\b|\bendl\b/.test(src))
  ) {
    return 'cpp'
  }

  if (best === 'js' && /\b(import|from|const|let|=>)\b/.test(src) && /<[A-Z]\w*/.test(src)) return 'tsx'

  return best
}
