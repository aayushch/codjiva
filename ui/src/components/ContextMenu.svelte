<script lang="ts">
  import { app, type MenuItem } from '$lib/state/app.svelte';

  // The app's menu: a short list of commands. It is used as the context menu,
  // at the point where the user right-clicked, and as the menu of a button,
  // under that button. `app.menu` holds the commands and the point. This
  // component draws the menu while `app.menu` is set.
  //
  // Placing. The menu's top-left corner is at the point in `app.menu`. If the
  // menu would reach past the right or the bottom edge of the window there,
  // it is moved left or up until it fits, with 8 px to spare.
  //
  // Closing. The menu closes when the user chooses a command, presses Escape,
  // presses the pointer anywhere outside it, scrolls, resizes the window or
  // switches to another window.
  //
  // Keys. The arrow keys move through the commands that are not disabled, and
  // Enter or Space runs the one that has focus. The first such command has
  // focus when the menu opens.
  //
  // A command can have a short word, `mark`, which is drawn at the right end
  // of its label.
  //
  // A command can also have a sentence of explanation, `detail`. The menu
  // lists labels only, and no sentence is on screen when the menu opens. The
  // sentence of a command is shown in a box beside the menu, level with that
  // command, while the pointer is on the command, and after an arrow key
  // moved the focus to it. The box is on the left of the menu. It is on the
  // right when the menu is too close to the left edge of the window for the
  // box to fit there.
  const MARGIN = 8;
  // The width in pixels that the box of a sentence needs beside the menu: the
  // box itself and the gap between it and the menu. `.menu-detail` in
  // app-extra.css sets both.
  const DETAIL_ROOM = 280;

  let box: HTMLDivElement | undefined = $state();
  // The menu's place once it has been measured. Both are 0 while no menu is
  // open and until a new menu has been measured, and the menu is then drawn
  // at the point of the click.
  let left = $state(0);
  let top = $state(0);
  // The position in `app.menu.items` of the command whose sentence is on
  // screen, or null when no sentence is on screen.
  let explained = $state<number | null>(null);

  $effect(() => {
    const menu = app.menu;
    explained = null;
    if (!menu) {
      left = 0;
      top = 0;
      return;
    }
    if (!box) return;
    const size = box.getBoundingClientRect();
    left = Math.max(
      MARGIN,
      Math.min(menu.x, window.innerWidth - size.width - MARGIN),
    );
    top = Math.max(
      MARGIN,
      Math.min(menu.y, window.innerHeight - size.height - MARGIN),
    );
    commands()[0]?.focus();
  });

  // The buttons of the commands that can be chosen, top to bottom.
  const commands = () =>
    Array.from(
      box?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );

  function choose(item: Exclude<MenuItem, 'separator'>) {
    app.closeMenu();
    item.action();
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      app.closeMenu();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const list = commands();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = list[(at + step + list.length) % list.length];
    next.focus();
    explained = Number(next.dataset.at);
  }

  // A press of the pointer outside the menu closes it. The listener is on the
  // window in the capture phase, so it also sees a press that the element
  // under the pointer handles itself.
  function onPress(event: PointerEvent) {
    if (app.menu && box && !box.contains(event.target as Node)) app.closeMenu();
  }
</script>

<svelte:window
  onpointerdowncapture={onPress}
  onresize={() => app.closeMenu()}
  onblur={() => app.closeMenu()}
  onwheel={() => app.closeMenu()}
/>

{#if app.menu}
  <div
    class="menu"
    class:detail-after={(left || app.menu.x) < DETAIL_ROOM}
    role="menu"
    tabindex="-1"
    bind:this={box}
    style:left="{left || app.menu.x}px"
    style:top="{top || app.menu.y}px"
    onkeydown={onKey}
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each app.menu.items as item, at}
      {#if item === 'separator'}
        <div class="menu-line" role="separator"></div>
      {:else}
        <button
          class="menu-item"
          role="menuitem"
          data-at={at}
          aria-describedby={item.detail ? `menu-detail-${at}` : undefined}
          disabled={item.disabled}
          onclick={() => choose(item)}
          onpointerenter={() => (explained = at)}
          onpointerleave={() => (explained = null)}
          ><span class="menu-label"
            >{item.label}{#if item.mark}<span class="menu-mark"
                >{item.mark}</span
              >{/if}</span
          >{#if item.detail}<span
              class="menu-detail"
              class:shown={explained === at}
              id="menu-detail-{at}">{item.detail}</span
            >{/if}</button
        >
      {/if}
    {/each}
  </div>
{/if}
