<script lang="ts">
  // The app's line icons, drawn inline. Every icon is a 16 x 16 outline with a 1.5 px stroke.
  type Name = 'dir' | 'file' | 'viz' | 'search' | 'play' | 'pause' | 'sound-on' | 'sound-off' | 'full' | 'settings' | 'close' | 'external' | 'target' | 'folder-open' | 'film' | 'reveal';

  let { name, size = 14 }: { name: Name; size?: number } = $props();

  const PATHS: Record<Name, string> = {
    dir: 'M1.5 4.5v8h13v-7H7.5l-1.5-1.5h-4.5z',
    file: 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3',
    viz: 'M3.5 3.5h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z M4 8h3l1.5-2 1.5 4 1-2h1',
    search: 'M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z M10.5 10.5 14 14',
    play: 'M5 3.5v9l7-4.5z',
    pause: 'M5 3.5v9 M11 3.5v9',
    'sound-on': 'M2.5 6v4h2.5l3.5 3V3L5 6H2.5z M11 5.5a3.5 3.5 0 0 1 0 5 M12.8 3.5a6.3 6.3 0 0 1 0 9',
    'sound-off': 'M2.5 6v4h2.5l3.5 3V3L5 6H2.5z M11 6l3.5 4 M14.5 6 11 10',
    full: 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10',
    // Three sliders, the usual sign for settings.
    settings: 'M2 4h6.5 M11.5 4H14 M10 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M2 8h2 M7 8h7 M5.5 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M2 12h6.5 M11.5 12H14 M10 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
    close: 'M3.5 3.5l9 9 M12.5 3.5l-9 9',
    external: 'M9.5 2.5h4v4 M13.5 2.5 7.5 8.5 M11.5 9.5v4h-9v-9h4',
    target: 'M13 8A5 5 0 1 1 3 8a5 5 0 0 1 10 0z M8 1v3 M8 12v3 M1 8h3 M12 8h3',
    'folder-open': 'M1.5 12.5v-9H6l1.5 1.5h6v2 M1.5 12.5l2-5.5h11l-2 5.5z',
    film: 'M2.5 3.5h11v9h-11z M5.5 3.5v9 M10.5 3.5v9 M2.5 6.5h3 M2.5 9.5h3 M10.5 6.5h3 M10.5 9.5h3',
    reveal: 'M1.5 4.5v8h13v-7H7.5l-1.5-1.5h-4.5z M6 9h4 M8.5 7.5 10 9l-1.5 1.5',
  };
</script>

<svg class="ico" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name]} />
</svg>
