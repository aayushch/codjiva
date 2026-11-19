<script lang="ts">
  import { app, type MenuItem } from '$lib/state/app.svelte';

  // The context menu: a short list of commands at the point where the user
  // right-clicked. `app.menu` holds the commands and that point. This
  // component draws the menu while `app.menu` is set.
  //
  // Placing. The menu's top-left corner is at the point of the click. If the
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
  // A command can have a sentence of explanation, `detail`, which is drawn
  // under its label, and a short word, `mark`, which is drawn at the right
  // end of its label. A menu with such a command is wider and its lines are
  // taller.
  const MARGIN = 8;

  let box: HTMLDivElement | undefined = $state();
  // The menu's place once it has been measured. Both are 0 while no menu is
  // open and until a new menu has been measured, and the menu is then drawn
  // at the point of the click.
  let left = $state(0);
  let top = $state(0);

  $effect(() => {
    const menu = app.menu;
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
    list[(at + step + list.length) % list.length].focus();
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
    role="menu"
    tabindex="-1"
    bind:this={box}
    style:left="{left || app.menu.x}px"
    style:top="{top || app.menu.y}px"
    onkeydown={onKey}
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each app.menu.items as item}
      {#if item === 'separator'}
        <div class="menu-line" role="separator"></div>
      {:else}
        <button
          class="menu-item"
          class:explained={!!item.detail}
          role="menuitem"
          disabled={item.disabled}
          onclick={() => choose(item)}
          ><span class="menu-label"
            >{item.label}{#if item.mark}<span class="menu-mark"
                >{item.mark}</span
              >{/if}</span
          >{#if item.detail}<span class="menu-detail">{item.detail}</span
            >{/if}</button
        >
      {/if}
    {/each}
  </div>
{/if}
