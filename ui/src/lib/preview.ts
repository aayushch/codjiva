// Which files the editor area shows as a picture or as a rendered page in
// place of their text, kept apart from the components so it can be tested.

// The ending of the last part of `path`, in small letters and without the
// dot. Empty for a name without a dot.
const endingOf = (path: string) => {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

// The endings of image files that are not text. Such a file has no source
// to show, so the Source view always shows the picture.
const PICTURES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'];

// True for a file that is shown as a picture and never as text.
export const isPicture = (path: string) => PICTURES.includes(endingOf(path));

// How a file of text can also be shown rendered.
//   - `image`: an SVG file, drawn as the picture it describes.
//   - `html`: an HTML file, laid out as a page. Its scripts do not run, and
//     it loads nothing from the network or from other files.
//   - `markdown`: a Markdown file, laid out as a document in the colours of
//     the app. It loads nothing from the network. Pictures that are files
//     of the workspace are shown.
export type PreviewKind = 'image' | 'html' | 'markdown';

// How the file at `path` can be shown rendered, told by the ending of its
// name, or null for a file that has only its text.
export function previewKindOf(path: string): PreviewKind | null {
  const ending = endingOf(path);
  if (ending === 'svg') return 'image';
  if (ending === 'html' || ending === 'htm') return 'html';
  if (ending === 'md' || ending === 'markdown') return 'markdown';
  return null;
}

// The path inside the workspace that `link` names when it is written in the
// file at `file`, or null when it names no file of the workspace.
//   - A link with a scheme, such as `https:` or `data:`, a link that starts
//     with `//`, and a link that is only a `#` part name no file, and give
//     null.
//   - A link that starts with one slash is taken from the root of the
//     workspace.
//   - Every other link is taken from the folder of `file`. A link that
//     leaves the workspace through `..` gives null.
// What follows a `?` or a `#` in the link is not part of the path.
export function pathFrom(file: string, link: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) return null;
  let plain = link.split(/[?#]/)[0];
  if (!plain) return null;
  try {
    plain = decodeURIComponent(plain);
  } catch {
    // A link that is not encoded correctly is used as it is written.
  }
  const parts = plain.startsWith('/') ? [] : file.split('/').slice(0, -1);
  for (const part of plain.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.length === 0) return null;
    else parts.pop();
  }
  return parts.length ? parts.join('/') : null;
}

// The colours and fonts of a Markdown page, as CSS values. PreviewView
// reads them from the app's own style, so the page follows the theme.
export type PageLook = {
  ground: string;
  text: string;
  strong: string;
  muted: string;
  line: string;
  panel: string;
  accent: string;
  font: string;
  mono: string;
};

// The whole HTML page for a Markdown file. `body` is the HTML that the
// Markdown was turned into, and `look` gives the colours and fonts.
export function markdownPage(body: string, look: PageLook): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html { background: ${look.ground}; }
  body {
    margin: 0;
    padding: 24px 32px 48px;
    max-width: 860px;
    color: ${look.text};
    font: 14px/1.6 ${look.font};
    overflow-wrap: break-word;
  }
  h1, h2, h3, h4, h5, h6 {
    margin: 1.6em 0 0.6em;
    color: ${look.strong};
    line-height: 1.25;
  }
  body > :first-child { margin-top: 0; }
  h1 { font-size: 1.9em; }
  h2 { font-size: 1.45em; }
  h3 { font-size: 1.2em; }
  h4, h5, h6 { font-size: 1em; }
  h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid ${look.line}; }
  p, ul, ol, pre, table, blockquote { margin: 0 0 1em; }
  ul, ol { padding-left: 1.6em; }
  li + li { margin-top: 0.25em; }
  li > ul, li > ol { margin: 0.25em 0 0; }
  a { color: ${look.accent}; text-decoration: underline; }
  strong { color: ${look.strong}; }
  code, pre { font-family: ${look.mono}; font-size: 0.92em; }
  code {
    padding: 0.1em 0.35em;
    border-radius: 4px;
    background: ${look.panel};
  }
  pre {
    padding: 12px 14px;
    border: 1px solid ${look.line};
    border-radius: 6px;
    background: ${look.panel};
    overflow: auto;
    line-height: 1.5;
  }
  pre code { padding: 0; background: none; font-size: 1em; }
  blockquote {
    padding: 0 0 0 14px;
    border-left: 3px solid ${look.line};
    color: ${look.muted};
  }
  table { border-collapse: collapse; display: block; overflow: auto; }
  th, td { padding: 6px 12px; border: 1px solid ${look.line}; }
  th { color: ${look.strong}; background: ${look.panel}; }
  hr { height: 1px; margin: 1.6em 0; border: 0; background: ${look.line}; }
  img { max-width: 100%; }
  li:has(> input[type='checkbox']) { list-style: none; margin-left: -1.4em; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
