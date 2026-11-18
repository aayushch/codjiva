## Summary

<!-- What does this PR do? Keep it to 1-3 sentences. -->

## Changes

<!-- Bullet list of what changed and why. -->

-

## Related Issues

<!-- Link issues: "Closes #123", "Fixes #456", "Part of #789" -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Enhancement to existing feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] Other: <!-- describe -->

## Component(s) Affected

- [ ] Core (jobs, artifacts, write guard)
- [ ] Agents and API providers
- [ ] Builder (`codjiva-build`)
- [ ] Runtime (visuals and films)
- [ ] Interface (Svelte)
- [ ] Tauri Shell (Rust)
- [ ] Prompts / schemas / agent definitions
- [ ] Landing page / docs

## Testing

<!-- How did you verify this works? -->

- [ ] Existing tests pass (`cargo test --workspace` / `npm run check` / `npm test`)
- [ ] `npm run style` passes
- [ ] Added new tests
- [ ] Manually tested in the app

### Test steps

<!-- Steps a reviewer can follow to verify: -->

1.

## Screenshots

<!-- If UI changes, include before/after screenshots. Delete this section if not applicable. -->

## Checklist

- [ ] My code follows the project conventions (see CONTRIBUTING.md)
- [ ] I've used Svelte 5 runes (`$state`, `$derived`, `$effect`) — no legacy `$:`
- [ ] A new backend call has its type, its Tauri call and its stand-in in `ui/src/lib/ipc/`
- [ ] Recorded sessions in `fixtures/replay/` are unchanged, or were recorded again
- [ ] I've tested on both dark and light themes (if UI change)
- [ ] If a prompt or an agent definition changed, the description says which jobs I ran with it
- [ ] I have read and understood every change in this PR myself, including anything an AI tool generated (see "Your responsibility for what you submit" in CONTRIBUTING.md)
