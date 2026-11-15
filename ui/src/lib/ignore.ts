// Helpers for the list of files and folders that are never suggested as
// companions. The patterns are written like the lines of a `.gitignore` file;
// the desktop app matches them.

export type Scope = {
  // The pattern that ignores exactly this scope.
  pattern: string;
  // True for a folder, false for the file itself.
  folder: boolean;
  // The path shown to the user, without the leading slash of the pattern.
  shown: string;
};

// The choices offered for ignoring a file: the file itself first, then each
// folder it is in, from the nearest folder up to the top one. Every pattern
// starts with a slash, which ties it to the workspace root, so `/vendor/` does
// not also match `tools/vendor/`.
export function scopesFor(path: string): Scope[] {
  const parts = path.split('/').filter(Boolean);
  const scopes: Scope[] = [
    { pattern: '/' + parts.join('/'), folder: false, shown: parts.join('/') },
  ];
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const dir = parts.slice(0, depth).join('/');
    scopes.push({ pattern: `/${dir}/`, folder: true, shown: `${dir}/` });
  }
  return scopes;
}

// The patterns in a block of text, one per line. Empty lines are dropped and a
// pattern is kept only the first time it appears.
export function parsePatterns(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !seen.has(line) && !!seen.add(line));
}
