// ESLint looks for mistakes in the JavaScript, TypeScript and Svelte code of
// the app, the runtime, the tests and the landing page. It does not judge
// layout: Prettier formats the code, and scripts/line-width.mjs checks the
// width of lines.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
  {
    // Build output, installed packages, test data and the example film that
    // agents read. The same folders are left out of formatting.
    ignores: [
      '**/node_modules/',
      '**/dist/',
      'target/',
      'ui/build/',
      'ui/src-tauri/',
      'ui/e2e/out/',
      'runtime/test/out/',
      'runtime/test/.cache/',
      'runtime/reference/',
      'fixtures/',
      'landing/demo/',
      'codeviz-spec/',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    rules: {
      // Messages from the sandboxed frames and from the agents are data of
      // no fixed shape, which the code checks by hand.
      '@typescript-eslint/no-explicit-any': 'off',
      // The lists in this interface are small and are replaced as a whole,
      // so an `each` block without a key is drawn correctly.
      'svelte/require-each-key': 'off',
      // A Map or Set that is not meant to redraw anything is a plain one.
      'svelte/prefer-svelte-reactivity': 'off',
      // A string in braces, such as {' · '}, keeps a space in the markup that
      // the formatter would otherwise move or drop.
      'svelte/no-useless-mustaches': 'off',
      // A name that starts with an underscore is unused on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The script of a Svelte file is TypeScript.
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  {
    // SourceView and CodeExcerpt put the lines of a file on the page as
    // HTML. Each line has been escaped and coloured by lib/highlight.ts
    // first, so it holds no markup of the file's own.
    files: [
      'ui/src/components/SourceView.svelte',
      'ui/src/components/CodeExcerpt.svelte',
    ],
    rules: { 'svelte/no-at-html-tags': 'off' },
  },
  {
    // The builder joins the files of runtime/src into one function, so a
    // name that one file declares is used by the files after it. ESLint
    // reads each file alone and cannot see that.
    files: ['runtime/src/**'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
