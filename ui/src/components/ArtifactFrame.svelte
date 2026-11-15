<script lang="ts">
  import { app } from '$lib/state/app.svelte';

  // The sandboxed frame every visual and film is shown in.
  //
  // The frame may run scripts and nothing else: it has its own isolated origin,
  // so the page inside cannot reach this app or anything the app can reach. The
  // two sides talk only through window messages, each an object with a `cj`
  // field that names the message.
  //
  // Theme. The page inside is transparent around its drawing, so what is behind
  // this frame shows through. The frame asks the page to draw in the app's
  // theme, `app.theme`, when the page loads and again whenever the theme
  // changes. The page answers with the palette it uses.
  //   - A page built by this version of the app answers `light` or `dark` as
  //     asked.
  //   - A page built before the light palette existed does not know the request
  //     and stays dark.
  // While the page is dark, the frame has the class `dark-stage`.
  // styles/theme.css uses that class to keep the area behind the frame dark
  // when the rest of the window is light.
  //
  // With `followTheme` set to false the page is never asked, and it stays dark.
  //
  // Keyboard. A click inside the frame gives the keyboard focus to the page
  // inside, and keys pressed after that would not reach this window, so the
  // app's shortcuts would stop working. The page needs no keys of its own here,
  // because FilmPlayer handles the film's keys in this window. So whenever the
  // frame receives the focus, the focus is taken away from it again.
  //
  // The frame is named with `aria-label` and not with `title`, because a
  // browser shows a title as a tooltip over the whole frame.
  let {
    src,
    title,
    onmessage,
    followTheme = true,
  }: {
    src: string;
    title: string;
    onmessage: (message: any) => void;
    followTheme?: boolean;
  } = $props();

  let frame: HTMLIFrameElement | undefined = $state();
  // The palette the page said it uses. It is null until the page has answered.
  let stageTheme = $state<'light' | 'dark' | null>(null);

  export function send(message: Record<string, unknown>) {
    frame?.contentWindow?.postMessage(message, '*');
  }

  // The theme request is sent before `hello`, so the page's `ready` answer to
  // `hello` already names the palette asked for.
  function onload() {
    if (followTheme) send({ cj: 'theme', mode: app.theme });
    send({ cj: 'hello' });
  }

  // A different page has not answered yet.
  $effect(() => {
    void src;
    stageTheme = null;
  });

  // Passes a change of the app's theme on to the page that is already loaded.
  $effect(() => {
    const mode = app.theme;
    if (followTheme) send({ cj: 'theme', mode });
  });

  // This window gets a `blur` event when the focus moves into the frame.
  // Chromium takes the focus back when the frame is blurred, and WebKit when
  // this window is focused, so both are done.
  $effect(() => {
    const takeFocusBack = () =>
      setTimeout(() => {
        if (!frame || document.activeElement !== frame) return;
        frame.blur();
        window.focus();
      }, 0);
    window.addEventListener('blur', takeFocusBack);
    return () => window.removeEventListener('blur', takeFocusBack);
  });

  $effect(() => {
    const handler = (event: MessageEvent) => {
      // Only messages from this frame's own page are accepted.
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (
        !message ||
        typeof message !== 'object' ||
        typeof message.cj !== 'string'
      )
        return;
      // `ready` carries the palette in `theme`, and the answer to a theme
      // request carries it in `mode`. A page that names no palette is an older
      // page, which is always dark.
      if (message.cj === 'ready') {
        stageTheme = message.theme === 'light' ? 'light' : 'dark';
        // A film starts to listen for messages only after it has prepared its
        // scenes, which can be later than the request `onload` sent. Such a
        // page reports `ready` in its default palette, so the request is sent
        // again. A page that names no palette cannot change it.
        if (followTheme && message.theme && message.theme !== app.theme)
          send({ cj: 'theme', mode: app.theme });
      } else if (message.cj === 'theme')
        stageTheme = message.mode === 'light' ? 'light' : 'dark';
      onmessage(message);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  });
</script>

<!-- svelte-ignore a11y_missing_attribute -->
<iframe
  bind:this={frame}
  {src}
  aria-label={title}
  class:dark-stage={stageTheme === 'dark'}
  sandbox="allow-scripts"
  {onload}
></iframe>
