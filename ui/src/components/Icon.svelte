<script lang="ts">
  // The app's line icons, drawn inline. Every icon is a 16 x 16 outline with a
  // 1.5 px stroke.
  type Name =
    | 'dir'
    | 'file'
    | 'viz'
    | 'search'
    | 'play'
    | 'pause'
    | 'sound-on'
    | 'sound-off'
    | 'full'
    | 'settings'
    | 'close'
    | 'external'
    | 'target'
    | 'folder-open'
    | 'film'
    | 'reveal'
    | 'again'
    | 'export'
    | 'panel'
    | 'sidebar'
    | 'inspector'
    | 'back'
    | 'forward'
    | 'copy'
    | 'check'
    | 'code'
    | 'swap'
    | 'chat';

  let { name, size = 14 }: { name: Name; size?: number } = $props();

  const PATHS: Record<Name, string> = {
    dir: 'M1.5 4.5v8h13v-7H7.5l-1.5-1.5h-4.5z',
    file: 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3',
    // A small diagram: one box with lines to two boxes on its right.
    viz: 'M1.5 6h4v4h-4z M10.5 2h4v4h-4z M10.5 10h4v4h-4z M5.5 8H8 M10.5 4H8v8h2.5',
    search: 'M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z M10.5 10.5 14 14',
    play: 'M5 3.5v9l7-4.5z',
    pause: 'M5 3.5v9 M11 3.5v9',
    'sound-on':
      'M2.5 6v4h2.5l3.5 3V3L5 6H2.5z M11 5.5a3.5 3.5 0 0 1 0 5 M12.8 3.5a6.3 6.3 0 0 1 0 9',
    'sound-off': 'M2.5 6v4h2.5l3.5 3V3L5 6H2.5z M11 6l3.5 4 M14.5 6 11 10',
    full: 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10',
    // Three sliders, the usual sign for settings.
    settings:
      'M2 4h6.5 M11.5 4H14 M10 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M2 8h2 M7 8h7 M5.5 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M2 12h6.5 M11.5 12H14 M10 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
    close: 'M3.5 3.5l9 9 M12.5 3.5l-9 9',
    external: 'M9.5 2.5h4v4 M13.5 2.5 7.5 8.5 M11.5 9.5v4h-9v-9h4',
    target: 'M13 8A5 5 0 1 1 3 8a5 5 0 0 1 10 0z M8 1v3 M8 12v3 M1 8h3 M12 8h3',
    'folder-open': 'M1.5 12.5v-9H6l1.5 1.5h6v2 M1.5 12.5l2-5.5h11l-2 5.5z',
    // A clapperboard with its striped arm raised.
    film: 'M2.5 7.5h11v6h-11z M2.5 7.5 1.9 5.2 12.5 2.3l.6 2.3z M5.4 4.2l1.5 2.1 M9 3.3l1.5 2.1',
    // A folder with a magnifying glass over its corner: find these files in
    // the file manager.
    reveal:
      'M7.5 12.5h-6V4H6l1.5 1.5h7v2.5 M13.5 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M13 12.5l1.5 1.5',
    // An arrow that goes round in a circle: make it again.
    again: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9l1.6 1.4 M13.5 2.5v3h-3',
    // An arrow that points down into a tray: save a copy.
    export: 'M8 2v8 M4.5 6.5 8 10l3.5-3.5 M2.5 11.5v2h11v-2',
    // A window with a panel along its bottom edge.
    panel: 'M2.5 2.5h11v11h-11z M2.5 10h11',
    // A window with a panel along its left edge, and one with a panel along its
    // right edge.
    sidebar: 'M2.5 2.5h11v11h-11z M6 2.5v11',
    inspector: 'M2.5 2.5h11v11h-11z M10 2.5v11',
    back: 'M13 8H3 M7 4 3 8l4 4',
    forward: 'M3 8h10 M9 4l4 4-4 4',
    // Two sheets, one behind the other: make a copy.
    copy: 'M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3',
    check: 'M3 8.5l3.5 3.5 6.5-7.5',
    // Two angle brackets with a slash between them: source code.
    code: 'M5 4.5 1.5 8 5 11.5 M11 4.5 14.5 8 11 11.5 M9.3 3 6.7 13',
    // One arrow up and one arrow down: swap the upper and the lower one.
    swap: 'M5 13V3 M2.5 5.5 5 3l2.5 2.5 M11 3v10 M8.5 10.5 11 13l2.5-2.5',
    // A speech bubble: a discussion.
    chat: 'M2.5 3h11v7.5H7L4 13v-2.5H2.5z',
  };
</script>

<svg
  class="ico"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PATHS[name]} />
</svg>
