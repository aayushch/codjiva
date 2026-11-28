<script lang="ts">
  import { api, type Blame, type NavSpan, type Scope } from '$lib/ipc';
  import { agoOf, blameLabel, dateOf, whoOf } from '$lib/blame';
  import { nextBookmark, reanchored } from '$lib/bookmarks';
  import { findCount, findMatches, firstMatchFrom } from '$lib/find';
  import { FILE_KINDS } from '$lib/artifacts';
  import { asMade, sameScope, scopeTitle, type FileScope } from '$lib/discuss';
  import { highlightLines, linesOf } from '$lib/highlight';
  import { hasPrototypes, wordAt } from '$lib/nav';
  import {
    app,
    CODE_FONT_DEFAULT,
    codeFontSize,
    type MenuItem,
  } from '$lib/state/app.svelte';
  import { discuss } from '$lib/state/discuss.svelte';
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';

  // The source viewer is read-only. Lines are `lineHeight` pixels tall and only
  // the lines in view are in the page, so a file of many thousand lines scrolls
  // smoothly. OVERSCAN more lines are kept in the page above and below the
  // view, so that a fast scroll does not show an empty area.
  //
  // `scrollTop` and `height` are copies of the view's scroll position and
  // height. `measure` reads them from the view. It runs when the view scrolls,
  // when its size changes and when a file has been loaded, so the lines in the
  // page always follow what the view shows.
  //
  // Code navigation. The names in the code can be followed.
  //   - A click on a name selects it. Its other uses in the file are marked,
  //     and the panel on the right of the window lists where it is defined
  //     and where it is used. A click anywhere else selects nothing.
  //   - A click with Command held (Control outside macOS) goes to the
  //     definition of the name. While that key is held, the name under the
  //     pointer is underlined.
  //   - A right-click on a name opens a menu with the same commands.
  //   - F12 goes to the definition of the selected name, Shift with F12 lists
  //     its references, and Escape selects nothing.
  // Dragging over the code selects text as in any page and follows no name.
  // The app's state (`app` in app.svelte.ts) asks the core what a name is;
  // this component only finds which name is under the pointer and draws the
  // marks.
  //
  // Finding text. Command with F (Control with F outside macOS) opens a small
  // bar in the top right corner of the view. Every place the typed text
  // stands in the file is marked, and the view shows one of them, which is
  // marked more strongly. Enter and the down button go to the next place,
  // Shift with Enter and the up button to the one before, and both start
  // again at the other end of the file. Command with G does the same from
  // the code. The "Aa" button tells capital letters from small ones. Escape
  // and the ✕ button close the bar and remove the marks. The whole file is
  // searched, also the lines that are not in the page (`findMatches` in
  // lib/find.ts).
  //
  // Bookmarks. A double click on a line number puts a bookmark on that line,
  // and a second one takes it away. A bookmarked line has an amber number
  // and a small ribbon in front of it. F2 goes to the next bookmark of the
  // file and Shift with F2 to the one before, starting again at the other
  // end of the file. Each bookmark also has a tick on the right edge of the
  // view, at the height its line has in the file, and a click on the tick
  // goes to the line. The bookmark button of Toolbar.svelte lists them. The
  // app keeps them between runs (`app.bookmarks`), and after the file
  // changed each one is put on the line that has its code now (`reanchored`
  // in lib/bookmarks.ts).
  //
  // The last change of a line. A click on a line asks git who changed that
  // line last, and the answer is written after the code of the line in a
  // muted colour: the author, how long ago, and the first line of the commit
  // message. While the pointer is over that text, a card shows the whole
  // commit message, the day and time, and the commit's hash with a button
  // that copies it. Nothing is shown for a file git does not track or in a
  // folder that is not a repository.
  //
  // Discussing and visualising selected code. When the user has selected
  // lines of code, a small bar appears near the end of the selection. Its
  // buttons start a discussion about that code, or make a visual of just
  // that code. Both open in the panel on the right of the window (see
  // SourcePanel.svelte). When the selection lies inside a function or a
  // type, the bar lets the user choose between the selected lines and the
  // whole definition. A right-click on the selection offers the same.
  //   - Code that has a discussion or a visual has a mark in front of its
  //     first line. A click on the mark opens it in the panel.
  //   - The lines of the code that is open in the panel have a tinted
  //     background.
  //
  // The props:
  //   - `relPath` is the file to show.
  //   - `line` is the line to scroll to and highlight, or null for none.
  //   - `span` names characters of that line to mark, when what led here
  //     was a name and not only a line.
  //   - `top`, when it is not null, is the first line to have in view. It
  //     is used in place of `line` for scrolling when the user comes back
  //     to a file with Back or Forward.
  //   - `reveal` is a number that changes each time the view is asked to
  //     show `line` again. The view scrolls whenever it changes.
  //   - `refresh` is a number that changes when the file changed on disk.
  //     The file is then read again and the view stays where it is.
  //
  // The size of the code is the setting `codeFontSize`, which the user
  // changes in Settings under Appearance. A line is 20 pixels tall at the
  // default size of 13 pixels and keeps that proportion at every other size.
  // Both are given to the styles as `--source-font-size` and
  // `--source-line-height`.
  const fontSize = $derived(codeFontSize(app.settings?.codeFontSize));
  const lineHeight = $derived(Math.round((fontSize * 20) / CODE_FONT_DEFAULT));
  const OVERSCAN = 30;

  let {
    relPath,
    line = null,
    span = null,
    top = null,
    reveal = 0,
    refresh = 0,
  }: {
    relPath: string;
    line?: number | null;
    span?: NavSpan | null;
    top?: number | null;
    reveal?: number;
    refresh?: number;
  } = $props();

  let viewport: HTMLDivElement | undefined = $state();
  // The element that holds the lines in the page.
  let rows: HTMLDivElement | undefined = $state();
  // The lines of the file as HTML, and the same lines as plain text.
  let lines = $state<string[]>([]);
  let text: string[] = [];
  let truncated = $state(false);
  let problem = $state<string | null>(null);
  let loading = $state(true);
  let scrollTop = $state(0);
  let height = $state(600);
  // The path of the file whose lines are in `lines`.
  let shownPath: string | null = null;

  // The first line in the page is never past the end of the file, whatever
  // `scrollTop` says.
  const first = $derived(
    Math.min(
      Math.max(0, Math.floor(scrollTop / lineHeight) - OVERSCAN),
      Math.max(0, lines.length - 1),
    ),
  );
  const last = $derived(
    Math.min(
      lines.length,
      Math.ceil((scrollTop + height) / lineHeight) + OVERSCAN,
    ),
  );
  const gutter = $derived(String(lines.length).length);

  // `measure` only writes `scrollTop` and `height` and never reads them, so
  // that an effect which calls it does not run again on every scroll.
  // `lastScrolled` is the scroll position `measure` saw last.
  let lastScrolled = 0;
  function measure() {
    if (!viewport) return;
    const scrolled = viewport.scrollTop;
    // The bar for the selected lines is placed in the window, so it would
    // stay behind when the code scrolls away under it. `lastScrolled` is a
    // plain variable, so that reading it here makes no effect run again.
    if (scrolled !== lastScrolled) {
      discuss.clearSelection();
      blameCard = null;
    }
    lastScrolled = scrolled;
    scrollTop = scrolled;
    height = viewport.clientHeight;
    app.sourceTop = Math.floor(scrolled / lineHeight) + 1;
  }

  // Reads and colours the file whenever a different file is shown, and again
  // when `refresh` says the file changed on disk. A different file starts at
  // its top. A file that is read again keeps its lines on screen until the
  // new ones are ready, and stays scrolled where it was.
  $effect(() => {
    const path = relPath;
    void refresh;
    let cancelled = false;
    if (path !== shownPath) {
      loading = true;
      problem = null;
      scrollTop = 0;
    }
    api
      .fileRead(path)
      .then(async (content) => {
        const html = await highlightLines(content.text, content.highlighter);
        if (cancelled) return;
        text = linesOf(content.text);
        lines = html;
        truncated = content.truncated;
        // The file may have changed since its bookmarks were made.
        const marks = app.bookmarksOf(path);
        const now = reanchored(marks, text);
        if (now !== marks) app.setBookmarks(path, now);
        problem = null;
        shownPath = path;
        loading = false;
      })
      .catch((error) => {
        if (cancelled) return;
        text = [];
        lines = [];
        problem = error?.message ?? String(error);
        shownPath = null;
        loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Scrolls when a file has been loaded and whenever `reveal` changes.
  //   - With `top` set, that line becomes the first line in view.
  //   - Otherwise, with `line` set, that line sits a third of the way down
  //     the view.
  //   - With neither, the view shows the top of the file.
  // `top` and `line` are read without being watched, so that a change to
  // one of them alone, which happens while the app is on its way to another
  // file, does not move the file that is still on screen.
  $effect(() => {
    void reveal;
    if (loading || !viewport) return;
    const [toTop, toLine] = untrack(() => [top, line]);
    viewport.scrollTop =
      toTop != null
        ? (toTop - 1) * lineHeight
        : toLine == null
          ? 0
          : Math.max(0, (toLine - 1) * lineHeight - viewport.clientHeight / 3);
    measure();
  });

  $effect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  });

  const onMac = $derived(app.info?.platform === 'macos');
  // True when the key that turns a click into "go to definition" is held.
  const followKey = (event: MouseEvent | KeyboardEvent) =>
    onMac ? event.metaKey : event.ctrlKey;

  // The element that holds the text of the line with the given number, or
  // null when that line is not in the page.
  function textOf(lineNumber: number): Element | null {
    const row = rows?.children[lineNumber - 1 - first];
    return row?.querySelector('.source-text') ?? null;
  }

  // The text node that holds the character at index `column` of a line, and
  // the index of that character inside the node. `holder` is the element
  // from `textOf`. For the column directly after the last character, the
  // last text node and its length are returned. Returns null for a column
  // further out.
  function charAt(holder: Element, column: number): [Text, number] | null {
    const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
    let before = 0;
    let lastNode: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = (node as Text).data.length;
      if (column < before + length) return [node as Text, column - before];
      before += length;
      lastNode = node as Text;
    }
    return lastNode && column === before
      ? [lastNode, lastNode.data.length]
      : null;
  }

  // The characters of `span` as a range of the page, or null when its line
  // is not in the page.
  function rangeOf(span: NavSpan): Range | null {
    const holder = textOf(span.line);
    if (!holder) return null;
    const start = charAt(holder, span.column);
    const end = charAt(holder, span.endColumn);
    if (!start || !end) return null;
    const range = new Range();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1]);
    return range;
  }

  // The kinds of coloured code that are never a name to follow. The kind
  // `tk-number` is not among them, because lib/highlight.ts also gives it to
  // named constants and to the members of an enum, which are names. A number
  // is not taken for a name either way: `wordAt` returns no word for text
  // that starts with a digit.
  const NOT_A_NAME = '.tk-comment, .tk-string, .tk-operator';

  // The name under the point (x, y) of the window, as its line and columns,
  // or null when the point is not over a name. A word in a comment, text in
  // quotes and a number are not names. The empty space after the end of a
  // line is not part of the line's last word.
  function nameAt(x: number, y: number): NavSpan | null {
    let node: Node | null = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const caret = document.caretPositionFromPoint(x, y);
      node = caret?.offsetNode ?? null;
      offset = caret?.offset ?? 0;
    } else if (document.caretRangeFromPoint) {
      const caret = document.caretRangeFromPoint(x, y);
      node = caret?.startContainer ?? null;
      offset = caret?.startOffset ?? 0;
    }
    const element = node instanceof Element ? node : node?.parentElement;
    const holder = element?.closest('.source-text');
    const row = holder?.parentElement;
    if (!node || !holder || !row || !viewport?.contains(holder)) return null;
    const lineNumber = Number(row.dataset.line);
    // The column is the length of the line's text in front of the caret.
    const before = new Range();
    before.setStart(holder, 0);
    before.setEnd(node, offset);
    const word = wordAt(text[lineNumber - 1] ?? '', before.toString().length);
    if (!word) return null;
    const found = {
      line: lineNumber,
      column: word.start,
      endColumn: word.end,
    };
    if (charAt(holder, word.start)?.[0].parentElement?.closest(NOT_A_NAME))
      return null;
    const box = rangeOf(found)?.getBoundingClientRect();
    if (!box || x < box.left - 1 || x > box.right + 1) return null;
    return found;
  }

  // The name under the pointer while the key for "go to definition" is held,
  // which is drawn underlined. `pointer` is where the pointer last was over
  // the view, so that pressing or releasing the key without moving the
  // pointer changes the underline too.
  let hover = $state<NavSpan | null>(null);
  let pointer: { x: number; y: number } | null = null;
  function underline(event: MouseEvent | KeyboardEvent) {
    hover =
      pointer && followKey(event) && !app.menu
        ? nameAt(pointer.x, pointer.y)
        : null;
  }

  // Where the pointer went down, to tell a click from a drag that selects
  // text.
  let pressedAt: { x: number; y: number } | null = null;
  const CLICK_SLACK = 3;
  // True from a press of the main button in the code until the pointer is
  // released, wherever that happens.
  let selecting = false;

  // The parts of this file that have a discussion or a visual, by the line
  // each starts on now. Each gets a mark in front of that line.
  const fileScopes = $derived(discuss.scopesIn(relPath));
  const marks = $derived.by(() => {
    const byLine = new Map<number, FileScope[]>();
    for (const one of fileScopes)
      byLine.set(one.now.startLine, [
        ...(byLine.get(one.now.startLine) ?? []),
        one,
      ]);
    return byLine;
  });
  // Where the part that is open in the panel is in this file now, or null.
  const openNow = $derived(
    app.scope?.path === relPath
      ? (fileScopes.find((one) => sameScope(one.scope, app.scope))?.now ??
          asMade(app.scope))
      : null,
  );

  // What the mark of the parts that start on one line says while the
  // pointer is on it.
  const markTip = (found: FileScope[]) =>
    found
      .map((one) =>
        [
          scopeTitle(one.scope, one.now),
          one.threads.length ? 'discussion' : '',
          ...one.artifacts.map(
            (made) =>
              FILE_KINDS.find((kind) => kind.kind === made.kind)?.label ??
              made.kind,
          ),
        ]
          .filter(Boolean)
          .join(' · '),
      )
      .join('\n');

  // A click on a mark opens its part in the panel. Where several parts
  // start on the same line, a menu lists them.
  function openMark(event: MouseEvent, found: FileScope[]) {
    event.stopPropagation();
    if (found.length === 1) return app.openScope(found[0].scope);
    app.openMenu(
      event,
      found.map((one) => ({
        label: scopeTitle(one.scope, one.now),
        action: () => app.openScope(one.scope),
      })),
    );
  }

  // The first and the last line in the page of which `range` covers at least
  // one character, or null when it covers none.
  //
  // The lines are found by comparing `range` with the text of every line in
  // the page, and not by looking at where `range` starts and ends. A drag
  // that ends below the last line, or outside the code, leaves the end of
  // the selection on an element that is not a line. A selection that ends in
  // front of the first character of a line covers nothing of that line, so
  // the line is not counted.
  function linesIn(range: Range): [number, number] | null {
    let start: number | null = null;
    let end: number | null = null;
    for (const row of rows?.children ?? []) {
      const holder = row.querySelector('.source-text');
      if (!holder) continue;
      const part = new Range();
      part.selectNodeContents(holder);
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
        part.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0)
        part.setEnd(range.endContainer, range.endOffset);
      if (part.collapsed || !holder.contains(part.startContainer)) continue;
      const number = Number((row as HTMLElement).dataset.line);
      start ??= number;
      end = number;
    }
    return start != null && end != null ? [start, end] : null;
  }

  // Called when the pointer is released after a press in the code. If text
  // is selected now, the selected lines become `discuss.selection`, and the
  // bar that offers to discuss or visualise them appears at the pointer.
  //
  // A selection inside one line counts only when it covers at least half of
  // the line's code, so that a word that was selected to copy it does not
  // bring the bar up.
  function onSelected(event: MouseEvent) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return discuss.clearSelection();
    const found = linesIn(selection.getRangeAt(0));
    if (!found) return discuss.clearSelection();
    const [start, end] = found;
    if (
      start === end &&
      selection.toString().trim().length <
        (text[start - 1] ?? '').trim().length / 2
    )
      return discuss.clearSelection();
    // The bar is placed at the pointer, but inside the code, for a drag
    // that ended outside it.
    const box = viewport?.getBoundingClientRect();
    const x = box
      ? Math.min(Math.max(event.clientX, box.left), box.right - 40)
      : event.clientX;
    const y = box
      ? Math.min(Math.max(event.clientY, box.top), box.bottom - 20)
      : event.clientY;
    discuss.select(relPath, start, end, x, y);
  }

  // The selection as the bar shows it: the scope its buttons act on, and
  // where the bar is. The bar is kept inside the window.
  const picked = $derived.by(() => {
    const now = discuss.selection;
    if (!now || now.path !== relPath) return null;
    const { lines, symbol, exact } = now.candidates;
    return {
      lines,
      symbol: symbol ?? null,
      // With `exact`, the lines are the definition, so there is no choice.
      choice: !!symbol && !exact,
      scope: now.useSymbol && symbol ? symbol : lines,
      left: Math.max(8, Math.min(now.x, window.innerWidth - 380)),
      top: Math.min(now.y + 14, window.innerHeight - 48),
    };
  });

  // Starts a discussion about `scope`: opens it in the panel, with the
  // keyboard focus in the question box.
  function discussScope(scope: Scope) {
    app.openScope(scope, null, true);
    discuss.clearSelection();
    window.getSelection()?.removeAllRanges();
  }

  // The commands that make a visual of `scope`, one for each kind.
  const visualiseItems = (scope: Scope): MenuItem[] => {
    const made = app.scopeArtifacts(scope);
    const thread = discuss.shown({ path: relPath, scope })?.id;
    return FILE_KINDS.map((kind) => ({
      label: kind.label,
      detail: kind.about,
      mark: made.some((one) => one.kind === kind.kind) ? 'made' : '',
      disabled: !app.activeAgent,
      action: () => {
        app.openScope(scope);
        discuss.clearSelection();
        app.askScoped(scope, kind.kind, thread);
      },
    }));
  };

  // The last change of the line the user clicked last. `found` is null
  // while git is being asked, and when git cannot say anything about the
  // line. `asked` is the time of the click in seconds since the start of
  // 1970, which the age of the commit is counted from.
  let blame = $state<{
    line: number;
    found: Blame | null;
    asked: number;
  } | null>(null);
  // Counts the questions to git, so that a slow answer about an earlier
  // line cannot replace the answer about the line clicked last.
  let blameAsks = 0;
  // Where the card with the whole commit is, in pixels of the window, or
  // null while it is hidden. `above` puts the card's bottom edge at `y` and
  // false puts its top edge there.
  let blameCard = $state<{ x: number; y: number; above: boolean } | null>(null);
  let blameCardTimer: ReturnType<typeof setTimeout> | undefined;
  const BLAME_CARD_WIDTH = 460;
  // How long the pointer rests on the text of the last change before the
  // card opens, in milliseconds.
  const BLAME_CARD_DELAY = 350;
  // Where the pointer was at the click that asked git, in pixels of the
  // window.
  let blameClick = { x: 0, y: 0 };

  // Asks git about `number`, a line of the file on screen. A second click on
  // the same line asks nothing. `event` is the click.
  function askBlame(number: number, event: MouseEvent) {
    if (blame?.line === number) return;
    const mine = ++blameAsks;
    const path = relPath;
    clearTimeout(blameCardTimer);
    blameCard = null;
    blameClick = { x: event.clientX, y: event.clientY };
    blame = { line: number, found: null, asked: Date.now() / 1000 };
    api
      .gitBlame(path, number)
      .catch(() => null)
      .then((found) => {
        if (mine !== blameAsks || path !== relPath) return;
        blame = found
          ? { line: number, found, asked: Date.now() / 1000 }
          : null;
      });
  }

  // Called while the pointer moves over the text of the last change, which
  // is the element `label`. The card opens when the pointer has rested on
  // the text for BLAME_CARD_DELAY milliseconds.
  //
  // The text is written at the end of the line the user clicked, so it can
  // appear under the pointer that made the click. The card does not open for
  // that: the pointer must first have moved more than CLICK_SLACK pixels
  // away from the place of the click.
  //
  // The card opens below the text. It opens above when the text is in the
  // lower half of the window, so that the card stays in the window.
  function overBlame(event: MouseEvent, label: HTMLElement) {
    if (
      Math.abs(event.clientX - blameClick.x) <= CLICK_SLACK &&
      Math.abs(event.clientY - blameClick.y) <= CLICK_SLACK
    )
      return;
    if (blameCard) return clearTimeout(blameCardTimer);
    clearTimeout(blameCardTimer);
    blameCardTimer = setTimeout(() => {
      if (!label.isConnected) return;
      const box = label.getBoundingClientRect();
      const above = box.top > window.innerHeight / 2;
      blameCard = {
        x: Math.max(
          8,
          Math.min(box.left, window.innerWidth - BLAME_CARD_WIDTH - 8),
        ),
        y: above ? window.innerHeight - box.top + 4 : box.bottom + 4,
        above,
      };
    }, BLAME_CARD_DELAY);
  }

  // Hides the card a moment after the pointer left the text or the card, so
  // that the pointer can cross the gap between the two. A card that was
  // about to open does not open.
  function hideBlameCardSoon() {
    clearTimeout(blameCardTimer);
    blameCardTimer = setTimeout(() => (blameCard = null), 200);
  }

  // Another file has no answer yet.
  $effect(() => {
    void relPath;
    blameAsks++;
    blame = null;
    blameCard = null;
  });

  // The bookmarks of the file on screen, and the lines they are on.
  const bookmarks = $derived(app.bookmarksOf(relPath));
  const bookmarked = $derived(new Set(bookmarks.map((mark) => mark.line)));

  // A double click on a line number adds a bookmark to its line, or removes
  // the one that is there.
  function onDoubleClick(event: MouseEvent) {
    const row = (event.target as Element)
      .closest('.source-num')
      ?.closest<HTMLElement>('.source-line');
    if (!row) return;
    const number = Number(row.dataset.line);
    app.toggleBookmark(relPath, number, text[number - 1] ?? '');
  }

  // Goes to the next bookmark of the file, or with `forward` false to the
  // one before. The search starts from the highlighted line (`line`) while
  // that line is in view. Otherwise it starts from the first line in view
  // going forward and from the last line in view going backward, so that the
  // nearest bookmark outside the view is found.
  function goToBookmark(forward: boolean) {
    const firstInView = Math.floor(scrollTop / lineHeight) + 1;
    const lastInView = Math.ceil((scrollTop + height) / lineHeight);
    const from =
      line != null && line >= firstInView && line <= lastInView
        ? line
        : forward
          ? firstInView - 1
          : lastInView + 1;
    const next = nextBookmark(bookmarks, from, forward);
    if (next) app.selectFile(relPath, next.line);
  }

  // How far down the view the tick of a bookmark on `number` is, in pixels:
  // the same share of the view's height as the line's place in the file.
  const tickTop = (number: number) =>
    Math.round(((number - 0.5) / Math.max(1, lines.length)) * height) - 1;

  function onClick(event: MouseEvent) {
    const press = pressedAt;
    pressedAt = null;
    if (event.button !== 0 || !press) return;
    if (
      Math.abs(event.clientX - press.x) > CLICK_SLACK ||
      Math.abs(event.clientY - press.y) > CLICK_SLACK
    )
      return;
    // A double click selects a word as text. Its first click has already
    // been handled here.
    if (event.detail > 1 || !window.getSelection()?.isCollapsed) return;
    const clicked = (event.target as Element).closest<HTMLElement>(
      '.source-line',
    );
    if (clicked) askBlame(Number(clicked.dataset.line), event);
    const name = nameAt(event.clientX, event.clientY);
    if (!name) return app.clearSymbol();
    if (followKey(event))
      app.goToDefinition(relPath, name.line, name.column, event.altKey);
    else app.selectSymbol(relPath, name.line, name.column);
  }

  function onMenu(event: MouseEvent) {
    const name = nameAt(event.clientX, event.clientY);
    const scope = picked?.scope;
    // Anywhere but on a name or on selected lines, the webview's own menu
    // is left to open.
    if (!name && !scope) return;
    hover = null;
    const items: MenuItem[] = [];
    if (name) {
      const { line, column } = name;
      items.push({
        label: 'Go to definition',
        action: () => app.goToDefinition(relPath, line, column),
      });
      if (hasPrototypes(relPath))
        items.push({
          label: 'Go to declaration',
          action: () => app.goToDefinition(relPath, line, column, true),
        });
      items.push({
        label: 'Find references',
        action: () => app.findReferences(relPath, line, column),
      });
    }
    if (scope) {
      if (items.length) items.push('separator');
      const what = scopeTitle(scope);
      items.push({
        label: `Discuss ${what}`,
        action: () => discussScope(scope),
      });
      for (const item of visualiseItems(scope))
        if (item !== 'separator')
          items.push({ ...item, label: `${item.label} of ${what}…` });
    }
    const selected = window.getSelection()?.toString();
    if (selected)
      items.push('separator', {
        label: 'Copy',
        action: () => navigator.clipboard.writeText(selected),
      });
    app.openMenu(event, items);
  }

  // The search for text in the file. `finding` is true while its bar is
  // open, `findQuery` is the text in its box and `findCase` is true when
  // capital letters are told from small ones.
  let finding = $state(false);
  let findQuery = $state('');
  let findCase = $state(false);
  let findInput: HTMLInputElement | undefined = $state();
  // Every place the text stands in the file. `lines` is read so that the
  // places are found again when another file, or the same file after a
  // change, has been loaded: `text` itself is not watched.
  const matches = $derived.by(() => {
    void lines;
    return finding ? findMatches(text, findQuery, findCase) : [];
  });
  // Which of `matches` the view shows, or -1 when there are none.
  let findIndex = $state(-1);
  // The line the search counts from when the text in the box changes: the
  // first line in view when the bar was opened, and after that the line of
  // the place the user last went to.
  let findFrom = 1;

  // Opens the bar, or goes back to its box when it is open. Text that is
  // selected on one line is put into the box.
  function openFind() {
    const picked = window.getSelection()?.toString() ?? '';
    if (picked && !picked.includes('\n')) findQuery = picked;
    if (!finding) findFrom = Math.floor(scrollTop / lineHeight) + 1;
    finding = true;
    tick().then(() => {
      findInput?.focus();
      findInput?.select();
    });
  }

  // Scrolls so that the place the search is at is in view. A line outside
  // the view is put a third of the way down it. Once that line is in the
  // page, the view is also scrolled sideways if the place is beyond its left
  // or right edge.
  function showMatch() {
    const match = matches[findIndex];
    if (!match || !viewport) return;
    const top = (match.line - 1) * lineHeight;
    const view = viewport;
    if (
      top < view.scrollTop + 2 * lineHeight ||
      top > view.scrollTop + view.clientHeight - 2 * lineHeight
    )
      view.scrollTop = Math.max(0, top - view.clientHeight / 3);
    tick().then(() => {
      const box = rangeOf(match)?.getBoundingClientRect();
      const frame = view.getBoundingClientRect();
      if (!box) return;
      if (box.left < frame.left + 60 || box.right > frame.right - 40)
        view.scrollLeft += box.left - frame.left - frame.width / 3;
    });
  }

  // Goes to the next place, or with `forward` false to the one before, and
  // from the last place to the first and back.
  function findNext(forward: boolean) {
    if (!matches.length) return;
    findIndex =
      (findIndex + (forward ? 1 : -1) + matches.length) % matches.length;
    findFrom = matches[findIndex].line;
    showMatch();
  }

  // When the places change, because the text in the box, the "Aa" button or
  // the file changed, the search shows the first place on or below
  // `findFrom`.
  $effect(() => {
    const found = matches;
    untrack(() => {
      findIndex = firstMatchFrom(found, findFrom);
      showMatch();
    });
  });

  function onFindKey(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      findNext(!event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finding = false;
    }
  }

  function onKey(event: KeyboardEvent) {
    underline(event);
    if (app.dialog || app.menu) return;
    // The keys of the search work wherever the keyboard is, also in the box
    // of the search itself. Command and Control both count, as for the
    // app's other keys in App.svelte.
    const command = event.metaKey || event.ctrlKey;
    if (command && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
      return;
    }
    if (finding && command && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      findNext(!event.shiftKey);
      return;
    }
    if ((event.target as HTMLElement).closest('input, textarea, select'))
      return;
    if (event.key === 'Escape' && finding) {
      finding = false;
      return;
    }
    if (event.key === 'Escape') discuss.clearSelection();
    if (event.key === 'F2') {
      event.preventDefault();
      goToBookmark(!event.shiftKey);
      return;
    }
    const symbol = app.symbol;
    if (!symbol) return;
    if (event.key === 'Escape') {
      app.clearSymbol();
    } else if (event.key === 'F12') {
      event.preventDefault();
      const { line, column } = symbol.lookup;
      if (event.shiftKey) app.findReferences(symbol.path, line, column);
      else app.goToDefinition(symbol.path, line, column);
    }
  }

  // The marks drawn over the code. Each is a named highlight of the page
  // (the CSS Custom Highlight API), which colours ranges of text without
  // changing the elements of the lines. The style sheet gives each name its
  // look. A webview without that API draws no marks, and the highlighted
  // line still shows where a jump led.
  //   - `nav-use`: the uses of the selected name in this file.
  //   - `nav-selected`: the selected name itself.
  //   - `nav-target`: the name that a jump led to.
  //   - `nav-link`: the name under the pointer while the key is held.
  const canMark =
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof Highlight !== 'undefined';
  //   - `find-match`: every place the text of the search stands.
  //   - `find-current`: the one of those places the search is at.
  // Where two marks cover the same text, the one with the greater number in
  // MARK_ORDER is drawn, so the place the search is at stands out from the
  // other places.
  const MARKS = [
    'nav-use',
    'nav-selected',
    'nav-target',
    'nav-link',
    'find-match',
    'find-current',
  ];
  const MARK_ORDER: Record<string, number> = {
    'find-match': 1,
    'find-current': 2,
  };

  // The uses of the selected name in this file: the places the lookup found
  // if the name was selected in this file, and the references the search
  // has found in this file so far.
  // A place that both found is listed once.
  const uses = $derived.by(() => {
    const symbol = app.symbol;
    if (!symbol) return [];
    const places = new Map<string, NavSpan>();
    const add = (span: NavSpan) =>
      places.set(`${span.line}:${span.column}`, span);
    if (symbol.path === relPath) symbol.lookup.occurrences.forEach(add);
    for (const reference of symbol.references)
      if (reference.path === relPath) add(reference);
    return Array.from(places.values());
  });
  const selected = $derived(
    app.symbol?.path === relPath ? app.symbol.lookup : null,
  );

  function mark(name: string, spans: NavSpan[]) {
    const ranges = spans
      .filter((one) => one.line > first && one.line <= last)
      .map(rangeOf)
      .filter((range) => range !== null);
    if (!ranges.length) return void CSS.highlights.delete(name);
    const highlight = new Highlight(...ranges);
    highlight.priority = MARK_ORDER[name] ?? 0;
    CSS.highlights.set(name, highlight);
  }

  // Draws the marks again whenever the lines in the page change, because a
  // range belongs to the elements of the lines it was made for.
  $effect(() => {
    if (!canMark || !rows || loading) return;
    void [lines, first, last];
    mark('nav-use', uses);
    mark('nav-selected', selected ? [selected] : []);
    mark('nav-target', span && span.line === line ? [span] : []);
    mark('nav-link', hover ? [hover] : []);
    mark('find-match', matches);
    mark('find-current', matches[findIndex] ? [matches[findIndex]] : []);
  });
  $effect(() => () => {
    if (canMark) for (const name of MARKS) CSS.highlights.delete(name);
  });
</script>

<!-- A drag that selects text can end outside the code, so the release of the
     pointer is listened for on the window. It counts only after a press in
     the code (`selecting`). -->
<svelte:window
  onkeydown={onKey}
  onkeyup={underline}
  onmouseup={(event) => {
    if (!selecting) return;
    selecting = false;
    if (event.button === 0) onSelected(event);
  }}
/>

<!-- The keyboard has its own way to every command a click gives here: F12,
     Shift with F12 and Escape act on the selected name, see `onKey`. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="source"
  class:linking={!!hover}
  style:--source-font-size="{fontSize}px"
  style:--source-line-height="{lineHeight}px"
  bind:this={viewport}
  onscroll={measure}
  onmousedown={(event) => {
    pressedAt = { x: event.clientX, y: event.clientY };
    selecting = event.button === 0;
    // A right-click on the selection keeps it, for the menu.
    if (event.button === 0) discuss.clearSelection();
  }}
  onclick={onClick}
  ondblclick={onDoubleClick}
  oncontextmenu={onMenu}
  onmousemove={(event) => {
    pointer = { x: event.clientX, y: event.clientY };
    if (event.buttons) hover = null;
    else underline(event);
  }}
  onmouseleave={() => {
    pointer = null;
    hover = null;
  }}
>
  {#if finding}
    <!-- The bar stays in the top right corner of the view while the code
         scrolls under it. A press in the bar is not a press in the code. -->
    <div class="source-find-holder">
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="source-find"
        role="search"
        onmousedown={(event) => event.stopPropagation()}
        onclick={(event) => event.stopPropagation()}
        ondblclick={(event) => event.stopPropagation()}
        oncontextmenu={(event) => event.stopPropagation()}
      >
        <input
          class="input"
          placeholder="Find in this file"
          aria-label="Find in this file"
          spellcheck="false"
          autocomplete="off"
          bind:this={findInput}
          bind:value={findQuery}
          onkeydown={onFindKey}
        />
        <span class="find-count" aria-live="polite"
          >{findQuery ? findCount(findIndex, matches.length) : ''}</span
        >
        <button
          class="tb-btn find-case tip-end"
          class:on={findCase}
          aria-pressed={findCase}
          aria-label="Match case"
          data-tip="Match case"
          onclick={() => (findCase = !findCase)}>Aa</button
        >
        <button
          class="tb-btn tip-end"
          aria-label="Previous match"
          data-tip="Previous (Shift+Enter)"
          disabled={!matches.length}
          onclick={() => findNext(false)}><Icon name="up" /></button
        >
        <button
          class="tb-btn tip-end"
          aria-label="Next match"
          data-tip="Next (Enter)"
          disabled={!matches.length}
          onclick={() => findNext(true)}><Icon name="down" /></button
        >
        <button
          class="tb-btn tip-end"
          aria-label="Close the search"
          data-tip="Close (Esc)"
          onclick={() => (finding = false)}><Icon name="close" /></button
        >
      </div>
    </div>
  {/if}
  {#if problem}
    <div class="source-note">{problem}</div>
  {:else if loading}
    <div class="source-note">Reading…</div>
  {:else}
    {#if bookmarks.length}
      <!-- The ticks stay at the right edge of the view while the code
           scrolls under them. A press on a tick is not a press in the code. -->
      <div class="source-ticks">
        {#each bookmarks as mark (mark.line)}
          <button
            class="source-tick"
            style:top="{tickTop(mark.line)}px"
            title="Bookmark on line {mark.line}"
            aria-label="Go to the bookmark on line {mark.line}"
            onmousedown={(event) => event.stopPropagation()}
            onclick={(event) => {
              event.stopPropagation();
              app.selectFile(relPath, mark.line);
            }}
          ></button>
        {/each}
      </div>
    {/if}
    <div
      class="source-sizer"
      style:height="{lines.length * lineHeight + (truncated ? 40 : 0)}px"
    >
      <div
        class="source-rows"
        style:top="{first * lineHeight}px"
        bind:this={rows}
      >
        {#each lines.slice(first, last) as html, i (first + i)}
          {@const number = first + i + 1}
          {@const found = marks.get(number)}
          <div
            class="source-line"
            class:ref={number === line}
            class:bookmarked={bookmarked.has(number)}
            class:found={!canMark && matches[findIndex]?.line === number}
            class:in-scope={!!openNow &&
              number >= openNow.startLine &&
              number <= openNow.endLine}
            data-line={number}
          >
            <span class="source-mark"
              >{#if found}<button
                  class="scope-mark tip-start"
                  class:visual={found.some((one) => one.artifacts.length > 0)}
                  class:lost={found.every((one) => one.now.state === 'lost')}
                  class:on={found.some((one) =>
                    sameScope(one.scope, app.scope),
                  )}
                  data-tip={markTip(found)}
                  aria-label="Open the discussion and visuals of {scopeTitle(
                    found[0].scope,
                    found[0].now,
                  )}"
                  onmousedown={(event) => event.stopPropagation()}
                  onclick={(event) => openMark(event, found)}
                ></button>{:else if bookmarked.has(number)}<span
                  class="bookmark-mark"
                ></span>{/if}</span
            ><span class="source-num" style:width="{gutter + 2}ch"
              >{number}</span
            ><span class="source-text">{@html html || ' '}</span
            >{#if blame?.line === number && blame.found}
              {@const found = blame.found}
              <!-- The text is not part of the code: a press on it selects
                   nothing and follows no name. -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class="source-blame"
                class:committed={found.committed}
                onmousedown={(event) => event.stopPropagation()}
                onclick={(event) => event.stopPropagation()}
                onmousemove={(event) => {
                  if (found.committed) overBlame(event, event.currentTarget);
                }}
                onmouseleave={hideBlameCardSoon}
                >{blameLabel(found, blame.asked)}</span
              >
            {/if}
          </div>
        {/each}
      </div>
      {#if truncated}
        <div class="source-cut" style:top="{lines.length * lineHeight}px">
          This file is longer than the viewer shows. Open it in your editor to
          see the rest.
        </div>
      {/if}
    </div>
  {/if}
</div>
{#if blameCard && blame?.found?.committed}
  {@const found = blame.found}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="blame-card"
    style:left="{blameCard.x}px"
    style:top={blameCard.above ? null : `${blameCard.y}px`}
    style:bottom={blameCard.above ? `${blameCard.y}px` : null}
    style:width="{BLAME_CARD_WIDTH}px"
    onmouseenter={() => clearTimeout(blameCardTimer)}
    onmouseleave={hideBlameCardSoon}
  >
    <div class="blame-head">
      <b>{whoOf(found)}</b>
      <span class="muted"
        >{agoOf(found.time, blame.asked)} · {dateOf(found.time)}</span
      >
    </div>
    <div class="blame-summary">{found.summary}</div>
    {#if found.body}<div class="blame-body">{found.body}</div>{/if}
    <div class="blame-foot">
      <code>{found.commit.slice(0, 7)}</code>
      <button
        class="blame-change"
        onclick={() => {
          blameCard = null;
          void app.openDiff(relPath, found.commit);
        }}>Show this change</button
      >
      <button
        class="tb-btn tip-end"
        aria-label="Copy the hash of the commit"
        data-tip="Copy the hash"
        onclick={() =>
          navigator.clipboard
            .writeText(found.commit)
            .then(() => app.notify('Copied the hash of the commit'))
            .catch((error) => app.fail(error))}><Icon name="copy" /></button
      >
    </div>
  </div>
{/if}
{#if picked}
  {@const scope = picked.scope}
  <div
    class="select-bar"
    role="toolbar"
    aria-label="Selected code"
    style:left="{picked.left}px"
    style:top="{picked.top}px"
  >
    {#if picked.choice && picked.symbol && discuss.selection}
      {@const selection = discuss.selection}
      <span class="seg" role="group" aria-label="What to use">
        <button
          class:on={!selection.useSymbol}
          aria-pressed={!selection.useSymbol}
          onclick={() => (selection.useSymbol = false)}
          >{scopeTitle(picked.lines)}</button
        ><button
          class:on={selection.useSymbol}
          aria-pressed={selection.useSymbol}
          title="The whole definition around the selected lines"
          onclick={() => (selection.useSymbol = true)}
          >{scopeTitle(picked.symbol)}</button
        >
      </span>
    {:else}
      <span class="what">{scopeTitle(scope)}</span>
    {/if}
    <button class="btn small primary" onclick={() => discussScope(scope)}
      >Discuss</button
    >
    <button
      class="btn small"
      aria-haspopup="menu"
      onclick={(event) =>
        app.openMenuBelow(event.currentTarget, visualiseItems(scope))}
      >Visualise ▾</button
    >
  </div>
{/if}
