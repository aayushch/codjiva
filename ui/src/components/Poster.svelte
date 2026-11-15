<script lang="ts">
  import { api } from '$lib/ipc';

  // A small live picture of an artifact: its own page, drawn once in a
  // miniature sandboxed frame. The frame is inert; clicks go to whatever
  // contains it.
  let { artifactId, version }: { artifactId: string; version: number } =
    $props();
</script>

<span class="thumb poster"
  ><iframe
    src={api.artifactUrl(`artifact/${artifactId}/${version}`) +
      '?embed=1&poster=1'}
    title=""
    sandbox="allow-scripts"
    tabindex="-1"
    loading="lazy"
  ></iframe></span
>
