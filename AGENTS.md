# AGENTS.md

Guidance for coding agents (and people) working in this repo.

## What this is

Claude Code mods: plugins of **function hooks** that run inside Claude Code.
Each top-level folder with a `.claude-plugin/plugin.json` is one mod. There is
no build step and no package.json. Claude Code compiles `hooks/register.tsx`
itself.

## The API

- The API is early access and changes between Claude Code releases. **The
  declaration file is the authority**, not memory: Claude Code writes it beside
  a loaded mod as `<mod>/.claude-plugin/types/claude-code/index.d.ts` (git-ignored).
  Grep it for the event or noun you need (`'tool.call'`, `PromptSubmitInput`,
  `process: {`) and read the declaration.
- In Claude Code, load the `plugin-authoring` skill before writing or debugging
  a hooks module.
- A hook is `($, e, next)`. Call `next(e)` (or `next({ ...e, ... })`) unless you
  mean to answer for the engine. `$` is the only way out: no Node, no DOM, no
  `require`, no dynamic `import()`.
- Functions that take `$` must be **top-level function declarations**. The
  validator rejects `$` passed into closures defined inside `register`.
- Never name a variable `h`: JSX compiles to `h(...)`, and shadowing it breaks
  every render in that scope.
- Matchers must be literals (`{ tool: 'Bash' }`, `{ command: 'prs' }`) or a
  RegExp, so `claude plugin validate` can read them.
- State a drawing reads lives in `$.state` through `atom()` and `read`/`update`,
  declared in `types/index.d.ts` and named as `"types"` in `plugin.json`.
  Module variables reset on every hot reload. Anything that must outlive the
  session goes in `$.store`.
- Long-running work starts in `session.start` with `$.clock.every`/`after`, not
  inside an event's dispatch. Work started from a hook that shouldn't hold up
  the turn goes through `$.clock.after(0, ...)`.

## Conventions

- One mod per folder, named in kebab-case. The folder name equals the manifest
  `name`.
- Match the existing style: two-space indent, single quotes, no semicolons, a
  short header comment in `register.tsx` saying what habit the mod removes.
- Mods must be safe by default:
  - git actions only on a clean working tree, and only fast-forward pulls;
  - no writes to the user's settings;
  - nothing that spends model usage without saying so in the README table
    (make it a `userConfig` option when it can be off).
- Anything shown on screen should be glanceable: a band is a few rows at most,
  and hides itself (`return next(e)`) when it has nothing to say.

## Before committing

Every mod a change touches must pass:

```sh
claude plugin validate <mod>
scripts/typecheck.sh <mod>/hooks/register.tsx
claude plugin test <mod>
```

`pre-commit install` wires these up with gitleaks, shellcheck and the
standard hygiene hooks. Every mod needs at least one `tests/*.test.ts` covering
the behaviour it exists for.

Tests run against the engine with nothing beneath the plugin. Stub what the mod
calls with the test's `on`: `on('process.run', () => ({ value: {...} }))`,
`on('session.start', ($, e) => ({ cwd: e.cwd }))`, and `mock.clock`/`mock.store`/
`mock.env` from `claude-code/testing`.

## Trying a change live

`scripts/sync.sh ~/.claude/dev-mods/<session-id>` copies the mods into a
session's hot-reload folder. They reload when the turn that changed them ends,
and the transcript names any mod that failed to load.

When you add a mod, also update the table and the "How each one works" section
in `README.md`.
