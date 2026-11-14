<script lang="ts">
  // The sandboxed frame every visual and film is shown in.
  //
  // The frame may run scripts and nothing else: it has its own isolated origin, so the page
  // inside cannot reach this app or anything the app can reach. The two sides talk only through
  // window messages, each an object with a `cj` field that names the message.
  let { src, title, onmessage }: { src: string; title: string; onmessage: (message: any) => void } = $props();

  let frame: HTMLIFrameElement | undefined = $state();

  export function send(message: Record<string, unknown>) {
    frame?.contentWindow?.postMessage(message, '*');
  }

  $effect(() => {
    const handler = (event: MessageEvent) => {
      // Only messages from this frame's own page are accepted.
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.data && typeof event.data === 'object' && typeof event.data.cj === 'string') onmessage(event.data);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  });
</script>

<iframe bind:this={frame} {src} {title} sandbox="allow-scripts" onload={() => send({ cj: 'hello' })}></iframe>
