import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRAMMARS, highlightLines, lineToHtml } from './highlight';

// A piece of code as the highlighter reports it. The colour names the kind.
const piece = (content: string, kind?: string) => ({
  content,
  offset: 0,
  color: kind ? `var(--code-${kind})` : undefined,
});

describe('lineToHtml', () => {
  it('wraps each kind in a span and leaves plain text bare', () => {
    expect(
      lineToHtml([
        piece('const', 'keyword'),
        piece(' x '),
        piece('=', 'operator'),
        piece(' '),
        piece('1', 'number'),
      ]),
    ).toBe(
      '<span class="tk-keyword">const</span> x ' +
        '<span class="tk-operator">=</span> <span class="tk-number">1</span>',
    );
  });

  it('joins pieces of the same kind that follow each other', () => {
    expect(lineToHtml([piece('//', 'comment'), piece(' a', 'comment')])).toBe(
      '<span class="tk-comment">// a</span>',
    );
  });

  it('escapes the characters HTML gives a meaning to', () => {
    expect(lineToHtml([piece('a < b && c > d')])).toBe(
      'a &lt; b &amp;&amp; c &gt; d',
    );
  });

  it('treats a colour that names no kind as plain text', () => {
    expect(lineToHtml([piece('x', 'nothing'), piece('y')])).toBe('xy');
  });
});

describe('highlightLines', () => {
  it('colours C++ by kind, one string per line', async () => {
    const lines = await highlightLines(
      [
        '#include <map>',
        '/* a block',
        '   comment */',
        'class Ledger {',
        '    bool add(const Entry& entry) { return count_ > 64; }',
        '};',
        '',
      ].join('\n'),
      'cpp',
    );
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('class="tk-meta"');
    expect(lines[1]).toBe('<span class="tk-comment">/* a block</span>');
    expect(lines[2]).toBe('<span class="tk-comment">   comment */</span>');
    expect(lines[3]).toContain('<span class="tk-keyword">class</span>');
    expect(lines[3]).toContain('<span class="tk-type">Ledger</span>');
    expect(lines[4]).toContain('<span class="tk-function">add</span>');
    expect(lines[4]).toContain('<span class="tk-keyword">return</span>');
    expect(lines[4]).toContain('<span class="tk-number">64</span>');
    expect(lines[4]).toContain('<span class="tk-operator">&gt;</span>');
  });

  it('knows the languages whose grammar has another name', async () => {
    const [objc] = await highlightLines(
      '@interface A : NSObject',
      'objectivec',
    );
    expect(objc).toContain('class="tk-');
    const [go] = await highlightLines('func main() {}', 'go');
    expect(go).toContain('<span class="tk-keyword">func</span>');
  });

  it('shows a file of an unknown language as plain text', async () => {
    expect(await highlightLines('a < b\nc', '')).toEqual(['a &lt; b', 'c']);
    expect(await highlightLines('a < b', 'klingon')).toEqual(['a &lt; b']);
  });

  it('colours the script, the markup and the style of a Svelte file', async () => {
    const lines = await highlightLines(
      [
        '<script lang="ts">',
        '  // The text beside the dial.',
        '  let { label }: { label: string } = $props();',
        '</script>',
        '<div class="dial">{label}</div>',
        '<style>',
        '  .dial { width: 6rem; }',
        '</style>',
      ].join('\n'),
      'svelte',
    );
    expect(lines[1]).toContain('class="tk-comment"');
    expect(lines[2]).toContain('<span class="tk-keyword">let</span>');
    expect(lines[2]).toContain('<span class="tk-type">string</span>');
    expect(lines[4]).toContain('<span class="tk-keyword">div</span>');
    expect(lines[4]).toContain('<span class="tk-string">"dial"</span>');
    expect(lines[6]).toContain('<span class="tk-member">width</span>');
    expect(lines[6]).toContain('<span class="tk-number">6rem</span>');
  });

  it('has a grammar for every language id the core names', () => {
    // Each row of the tables in lang.rs ends with the id of the grammar
    // that colours the language, or with "" for a language shown as plain
    // text: `("svelte", "Svelte", "svelte"),`.
    const table = readFileSync(
      new URL('../../../crates/codjiva-core/src/lang.rs', import.meta.url),
      'utf8',
    );
    const ids = [...table.matchAll(/^\s*\("[^"]+", "[^"]+", "([^"]*)"\),$/gm)]
      .map((row) => row[1])
      .filter((id) => id !== '');
    expect(ids.length).toBeGreaterThan(40);
    expect(ids.filter((id) => !GRAMMARS[id])).toEqual([]);
  });
});
