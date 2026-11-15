// Turns source text into one HTML string per line, coloured when the file's
// language is known and the file is small enough.
//
// The colouring is done by Shiki, which reads code with the same grammars as
// Visual Studio Code. A grammar gives every piece of code a list of scopes,
// such as `storage.modifier` for `const` or `entity.name.function` for the
// name of a function. CODE_THEME below sorts those scopes into the few kinds
// of KINDS. Each piece is then written as `<span class="tk-keyword">` and so
// on, and the style sheet gives each kind its colour in the dark and in the
// light theme. A piece of no kind is written as plain text.

import type { HighlighterCore, ThemedToken } from 'shiki/core';

// Files above these sizes are shown as plain text: colouring them would freeze
// the window.
const HIGHLIGHT_LIMIT_BYTES = 400_000;
const HIGHLIGHT_LIMIT_LINES = 15_000;

// The kinds of code that have a colour of their own.
//   - comment: a comment.
//   - keyword: a word of the language, such as `if`, `class` or `const`.
//   - operator: an operator sign, such as `=` or `&&`.
//   - string: text in quotes.
//   - number: a number, and a fixed value such as `true` or `nullptr`.
//   - function: the name of a function where it is defined or called.
//   - type: the name of a type, a class or a namespace.
//   - param: a parameter of a function.
//   - member: a field or a property of an object.
//   - meta: a line for the compiler or the build, such as `#include`, and a
//     decorator or an annotation.
const KINDS = [
  'comment',
  'keyword',
  'operator',
  'string',
  'number',
  'function',
  'type',
  'param',
  'member',
  'meta',
] as const;
type Kind = (typeof KINDS)[number];

// Which scopes belong to which kind. A piece of code is given the kind of the
// most specific scope that matches it, as in any TextMate theme. So `=`, whose
// scope is `keyword.operator.assignment`, is an operator although `keyword` is
// listed as a keyword, and `new`, whose scope is `keyword.operator.new`, is a
// keyword again. Between two entries that are equally specific, the later one
// is used.
const SCOPES: [Kind, string[]][] = [
  ['keyword', ['keyword', 'storage', 'variable.language', 'entity.name.tag']],
  ['operator', ['keyword.operator', 'punctuation.separator.pointer-access']],
  [
    'keyword',
    [
      'keyword.operator.new',
      'keyword.operator.delete',
      'keyword.operator.expression',
      'keyword.operator.wordlike',
      'keyword.operator.sizeof',
      'keyword.operator.cast',
      'keyword.operator.alignof',
      'keyword.operator.typeid',
      'keyword.operator.noexcept',
      'keyword.operator.logical.python',
      'keyword.operator.word',
    ],
  ],
  ['string', ['string', 'markup.inline.raw', 'markup.fenced_code']],
  [
    'number',
    [
      'constant.numeric',
      'constant.language',
      'constant.character',
      'constant.other',
      'support.constant',
      'variable.other.constant',
      'variable.other.enummember',
      'keyword.other.unit',
    ],
  ],
  [
    'function',
    [
      'entity.name.function',
      'support.function',
      'meta.function-call.generic',
      'variable.function',
      'markup.heading',
    ],
  ],
  [
    'type',
    [
      'entity.name.type',
      'entity.name.class',
      'entity.name.namespace',
      'entity.name.scope-resolution',
      'entity.other.inherited-class',
      'support.type',
      'support.class',
      'storage.type.built-in',
      'storage.type.primitive',
      'keyword.type',
    ],
  ],
  ['param', ['variable.parameter']],
  [
    'member',
    [
      'variable.other.member',
      'variable.other.property',
      'variable.other.object.property',
      'support.variable.property',
      'entity.other.attribute-name',
      'support.type.property-name',
      'meta.object-literal.key',
    ],
  ],
  [
    'meta',
    [
      'meta.preprocessor',
      'keyword.control.directive',
      'keyword.control.import',
      'punctuation.definition.directive',
      'entity.name.function.preprocessor',
      'entity.name.function.decorator',
      'meta.decorator',
      'meta.attribute',
      'storage.type.annotation',
      'punctuation.definition.annotation',
    ],
  ],
  ['string', ['meta.preprocessor string', 'string.quoted.other.lt-gt.include']],
  ['comment', ['comment', 'punctuation.definition.comment']],
];

// The colour Shiki reports for a piece of code of `kind`. It is never used as
// a colour: `kindOf` reads the kind back out of it.
const colourOf = (kind: Kind) => `var(--code-${kind})`;

const CODE_THEME = {
  name: 'codjiva',
  type: 'dark' as const,
  colors: {},
  tokenColors: SCOPES.map(([kind, scope]) => ({
    scope,
    settings: { foreground: colourOf(kind) },
  })),
};

// The kind of a piece of code, or null for plain text.
function kindOf(token: ThemedToken): Kind | null {
  const kind = token.color?.match(/^var\(--code-([a-z]+)\)$/)?.[1];
  return KINDS.includes(kind as Kind) ? (kind as Kind) : null;
}

// The grammar of each language the app names (see lang.rs in the core crate),
// by the id the app uses for it. Each grammar is loaded when a file of that
// language is first shown.
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  clojure: () => import('shiki/langs/clojure.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  dos: () => import('shiki/langs/bat.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  erlang: () => import('shiki/langs/erlang.mjs'),
  fsharp: () => import('shiki/langs/fsharp.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  gradle: () => import('shiki/langs/groovy.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  nim: () => import('shiki/langs/nim.mjs'),
  objectivec: () => import('shiki/langs/objective-c.mjs'),
  ocaml: () => import('shiki/langs/ocaml.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  protobuf: () => import('shiki/langs/protobuf.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vbnet: () => import('shiki/langs/vb.mjs'),
  x86asm: () => import('shiki/langs/asm.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Writes the pieces of one line as HTML. Pieces of the same kind that follow
// each other share one <span>.
export function lineToHtml(tokens: ThemedToken[]): string {
  let html = '';
  let open: Kind | null = null;
  for (const token of tokens) {
    const kind = kindOf(token);
    if (kind !== open) {
      if (open) html += '</span>';
      if (kind) html += `<span class="tk-${kind}">`;
      open = kind;
    }
    html += escapeHtml(token.content);
  }
  return open ? html + '</span>' : html;
}

// The highlighter, made on first use so that it is not part of the app's
// start-up code. `loaded` holds each language whose grammar the highlighter
// has: the app's id for the language, and the name the grammar gives itself,
// which is the name the highlighter knows it by.
let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, string>();

// Returns the highlighter with the grammar of `language` loaded, and the name
// of that grammar. A grammar file holds the grammars it builds on first and
// its own grammar last.
async function highlighterFor(
  language: string,
): Promise<[HighlighterCore, string]> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
    return createHighlighterCore({
      themes: [CODE_THEME],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  const ready = await highlighter;
  let name = loaded.get(language);
  if (!name) {
    const grammars = ((await GRAMMARS[language]()) as { default: any[] })
      .default;
    await ready.loadLanguage(grammars);
    name = grammars[grammars.length - 1].name as string;
    loaded.set(language, name);
  }
  return [ready, name];
}

// Returns the file as HTML lines. `language` is the app's id for the file's
// language, or "" for none.
export async function highlightLines(
  text: string,
  language: string,
): Promise<string[]> {
  // A trailing newline ends the last line; it does not start an empty one.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const plain = () => body.split('\n').map(escapeHtml);
  if (!GRAMMARS[language] || body.length > HIGHLIGHT_LIMIT_BYTES)
    return plain();
  if (body.split('\n').length > HIGHLIGHT_LIMIT_LINES) return plain();
  try {
    const [ready, name] = await highlighterFor(language);
    return ready
      .codeToTokensBase(body, { lang: name, theme: CODE_THEME.name })
      .map(lineToHtml);
  } catch {
    return plain();
  }
}
