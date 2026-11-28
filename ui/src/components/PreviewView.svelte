<script lang="ts">
  import { api } from '$lib/ipc';
  import {
    isPicture,
    markdownPage,
    pathFrom,
    previewKindOf,
    type PageLook,
    type PreviewKind,
  } from '$lib/preview';
  import { formatBytes } from '$lib/tree';

  // What the editor area shows for a file in place of its text.
  //   - `kind` `image`: the picture of an image file, in the middle of the
  //     area on a chequered ground, which shows where the picture is
  //     transparent. Below it are its width and height in pixels and the
  //     size of the file. A picture larger than the area is made smaller to
  //     fit, and a smaller one is shown at its own size.
  //   - `kind` `html`: the page an HTML file describes, in a frame that may
  //     do nothing: its scripts do not run, and the window's content policy
  //     lets it load nothing from the network. Pictures and style sheets the
  //     page refers to by a path are not loaded either.
  //   - `kind` `markdown`: the document a Markdown file describes, in the
  //     same kind of frame and in the colours of the app. A picture that is
  //     an image file of the workspace is shown. A picture from the network
  //     is not. A link shows where it leads in its tooltip and does nothing
  //     when it is clicked, because the frame cannot go to another page.
  //
  // `relPath` is the file's path inside the workspace. `refresh` is a number
  // that changes when the file changed on disk, and the file is then read
  // again.
  let {
    relPath,
    kind,
    refresh = 0,
  }: { relPath: string; kind: PreviewKind; refresh?: number } = $props();

  // How many pictures of a Markdown file are read from the workspace. The
  // pictures after these are left as the file names them, and are not
  // shown.
  const PICTURE_LIMIT = 30;

  // What was read: the address of the picture and the size of its file, the
  // text of an HTML file, or the HTML that a Markdown file was turned into.
  // `problem` is the reason when reading failed.
  let picture = $state<{ url: string; bytes: number } | null>(null);
  let html = $state<string | null>(null);
  let markdown = $state<string | null>(null);
  let problem = $state<string | null>(null);
  // The width and height of the picture in pixels, once it is drawn.
  let size = $state<{ width: number; height: number } | null>(null);

  // The theme of the app, `light` or `dark`, as the root element of the
  // window has it in its `data-theme` attribute. It is followed here so that
  // a Markdown page is laid out again in the new colours when the theme
  // changes.
  let theme = $state(document.documentElement.dataset.theme);
  $effect(() => {
    const observer = new MutationObserver(() => {
      theme = document.documentElement.dataset.theme;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  });

  // The colours and fonts of the app, read from the style of the window.
  // The frame of the page does not have the app's style sheets, so the
  // values are written into the page.
  function lookOfApp(): PageLook {
    const style = getComputedStyle(document.documentElement);
    const value = (name: string) => style.getPropertyValue(name).trim();
    return {
      ground: value('--ground'),
      text: value('--ink'),
      strong: value('--second'),
      muted: value('--muted'),
      line: value('--shell-border'),
      panel: value('--panel'),
      accent: value('--accent'),
      font: value('--font') || 'sans-serif',
      mono: value('--mono') || 'monospace',
    };
  }

  // Makes the HTML of a Markdown file fit for the frame. `body` is the HTML
  // and `file` is the path of the Markdown file.
  //   - `meta` and `base` elements are removed, because they can send the
  //     frame to another page.
  //   - Each link loses its address, which is kept as its tooltip. A click
  //     on a link would replace the document in the frame with a page the
  //     frame is not allowed to load.
  //   - Each picture that names an image file of the workspace gets the
  //     content of that file as its address. A picture whose file cannot be
  //     read is left as it is.
  async function fitted(file: string, body: string): Promise<string> {
    const doc = new DOMParser().parseFromString(body, 'text/html');
    for (const node of doc.querySelectorAll('meta, base')) node.remove();
    for (const link of doc.querySelectorAll('a[href]')) {
      link.setAttribute('title', link.getAttribute('href') ?? '');
      link.removeAttribute('href');
    }
    const pictures = [...doc.querySelectorAll('img[src]')].slice(
      0,
      PICTURE_LIMIT,
    );
    await Promise.all(
      pictures.map(async (image) => {
        const path = pathFrom(file, image.getAttribute('src') ?? '');
        if (!path) return;
        if (!isPicture(path) && previewKindOf(path) !== 'image') return;
        try {
          image.setAttribute('src', (await api.fileImage(path)).dataUrl);
        } catch {
          // The picture stays as the file names it, and is not shown.
        }
      }),
    );
    return doc.body.innerHTML;
  }

  // Reads the Markdown file at `path` and turns it into HTML. The library
  // that does this is loaded when the first Markdown file is previewed.
  async function readMarkdown(path: string): Promise<string> {
    const [content, { marked }] = await Promise.all([
      api.fileRead(path),
      import('marked'),
    ]);
    return fitted(path, await marked.parse(content.text, { gfm: true }));
  }

  $effect(() => {
    const path = relPath;
    const how = kind;
    void refresh;
    let cancelled = false;
    picture = null;
    html = null;
    markdown = null;
    problem = null;
    size = null;
    const read =
      how === 'image'
        ? api.fileImage(path).then((image) => {
            if (!cancelled)
              picture = { url: image.dataUrl, bytes: image.bytes };
          })
        : how === 'html'
          ? api.fileRead(path).then((content) => {
              if (!cancelled) html = content.text;
            })
          : readMarkdown(path).then((body) => {
              if (!cancelled) markdown = body;
            });
    read.catch((error) => {
      if (!cancelled) problem = error?.message ?? String(error);
    });
    return () => {
      cancelled = true;
    };
  });

  // The document the frame shows: the text of the HTML file itself, or the
  // page that is built around the HTML of a Markdown file. Null while the
  // file is being read, and for a picture.
  const page = $derived.by(() => {
    if (html != null) return html;
    if (markdown == null) return null;
    void theme;
    return markdownPage(markdown, lookOfApp());
  });
</script>

<div class="preview" class:page={kind !== 'image'}>
  {#if problem}
    <div class="source-note">{problem}</div>
  {:else if picture}
    <div class="preview-picture">
      <img
        src={picture.url}
        alt={relPath}
        onload={(event) => {
          const image = event.currentTarget as HTMLImageElement;
          size = { width: image.naturalWidth, height: image.naturalHeight };
        }}
        onerror={() => (problem = 'This image could not be drawn.')}
      />
    </div>
    <div class="preview-about">
      {size ? `${size.width} × ${size.height} px · ` : ''}{formatBytes(
        picture.bytes,
      )}
    </div>
  {:else if page != null}
    <iframe
      class="preview-frame"
      class:themed={kind === 'markdown'}
      title={relPath}
      sandbox=""
      srcdoc={page}
    ></iframe>
  {:else}
    <div class="source-note">Reading…</div>
  {/if}
</div>
