// Turns source text into one HTML string per line, coloured by the highlighter
// when the file's language is known and the file is small enough.

// Files above these sizes are shown as plain text: colouring them would freeze
// the window.
const HIGHLIGHT_LIMIT_BYTES = 400_000;
const HIGHLIGHT_LIMIT_LINES = 15_000;

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Splits highlighted HTML into lines. The highlighter wraps tokens in <span>
// elements, and a token such as a block comment can run over several lines.
// Each returned line is valid HTML by itself: spans still open at a line break
// are closed there and opened again on the next line.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const tag = /<span[^>]*>|<\/span>|\n/g;
  let at = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    current += html.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[0] === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (m[0] === '</span>') {
      open.pop();
      current += m[0];
    } else {
      open.push(m[0]);
      current += m[0];
    }
  }
  current += html.slice(at);
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}

// Returns the file as HTML lines. `language` is the highlighter's language id,
// or "" for none.
export async function highlightLines(
  text: string,
  language: string,
): Promise<string[]> {
  // A trailing newline ends the last line; it does not start an empty one.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const plain = () => body.split('\n').map(escapeHtml);
  if (!language || body.length > HIGHLIGHT_LIMIT_BYTES) return plain();
  const lineCount = body.split('\n').length;
  if (lineCount > HIGHLIGHT_LIMIT_LINES) return plain();
  try {
    // Loaded on first use so the highlighter is not part of the app's start-up
    // code.
    const { default: hljs } = await import('highlight.js/lib/common');
    if (!hljs.getLanguage(language)) return plain();
    return splitHighlightedLines(
      hljs.highlight(body, { language, ignoreIllegals: true }).value,
    );
  } catch {
    return plain();
  }
}
