import { describe, expect, it } from 'vitest';
import { isPicture, markdownPage, pathFrom, previewKindOf } from './preview';

describe('isPicture', () => {
  it('is true for image files that are not text, whatever the case', () => {
    expect(isPicture('ui/icons/128x128@2x.png')).toBe(true);
    expect(isPicture('photo.JPG')).toBe(true);
    expect(isPicture('logo.svg')).toBe(false);
    expect(isPicture('png')).toBe(false);
    expect(isPicture('src/png.go')).toBe(false);
  });
});

describe('previewKindOf', () => {
  it('says how a file of text can be shown rendered', () => {
    expect(previewKindOf('landing/images/logo.svg')).toBe('image');
    expect(previewKindOf('landing/index.html')).toBe('html');
    expect(previewKindOf('old/page.HTM')).toBe('html');
    expect(previewKindOf('README.md')).toBe('markdown');
    expect(previewKindOf('notes.markdown')).toBe('markdown');
    expect(previewKindOf('main.go')).toBeNull();
    expect(previewKindOf('icon.png')).toBeNull();
  });
});

describe('pathFrom', () => {
  it('takes a link from the folder of the file it is written in', () => {
    expect(pathFrom('docs/guide.md', 'shot.png')).toBe('docs/shot.png');
    expect(pathFrom('docs/guide.md', './img/a%20b.png')).toBe(
      'docs/img/a b.png',
    );
    expect(pathFrom('docs/guide.md', '../logo.svg?raw=true#top')).toBe(
      'logo.svg',
    );
    expect(pathFrom('README.md', 'docs/shot.png')).toBe('docs/shot.png');
  });

  it('takes a link that starts with a slash from the workspace root', () => {
    expect(pathFrom('docs/guide.md', '/art/logo.svg')).toBe('art/logo.svg');
  });

  it('gives null for a link that names no file of the workspace', () => {
    expect(pathFrom('README.md', 'https://example.com/a.png')).toBeNull();
    expect(pathFrom('README.md', 'data:image/png;base64,AAAA')).toBeNull();
    expect(pathFrom('README.md', '//example.com/a.png')).toBeNull();
    expect(pathFrom('README.md', '#install')).toBeNull();
    expect(pathFrom('README.md', '../outside.png')).toBeNull();
  });
});

describe('markdownPage', () => {
  it('puts the body in a page with the given colours', () => {
    const page = markdownPage('<h1>Shop</h1>', {
      ground: '#101010',
      text: '#cccccc',
      strong: '#ffffff',
      muted: '#888888',
      line: '#333333',
      panel: '#181818',
      accent: '#4fb0c6',
      font: 'sans-serif',
      mono: 'monospace',
    });
    expect(page).toContain('<h1>Shop</h1>');
    expect(page).toContain('background: #101010');
    expect(page).toContain('color: #4fb0c6');
  });
});
