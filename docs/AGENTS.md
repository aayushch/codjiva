# Adding or changing an agent

Codjiva starts a command-line agent the way its **definition** says. A definition is a small JSON file. The ones
that ship with the app are in `resources/adapters/`. You can change one, or add an agent of your own, without
rebuilding the app.

## Where your own definitions go

Put a `.json` file in the `adapters` folder of Codjiva's settings folder:

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/sh.aay.codjiva/adapters/` |
| Linux | `~/.config/codjiva/adapters/` |
| Windows | `%APPDATA%\aay\codjiva\config\adapters\` |

A file whose `id` matches a bundled definition replaces it. A file with a new `id` adds an agent. A file that
cannot be read is skipped and the other agents still load. Use **Settings → Look for agents again** after
changing a file.

## The fields

```json
{
  "id": "claude-code",
  "name": "Claude Code",
  "program": "claude",
  "versionArgs": ["--version"],
  "helpArgs": ["--help"],
  "args": ["-p", "--output-format", "stream-json", "--append-system-prompt-file", "{systemPromptPath}"],
  "modelArgs": ["--model", "{model}"],
  "defaultModel": "sonnet",
  "effortArgs": ["--effort", "{effort}"],
  "resumeArgs": ["--resume", "{sessionId}"],
  "budgetArgs": ["--max-budget-usd", "{maxBudgetUsd}"],
  "stdin": "{userPromptText}",
  "cwd": "{workspaceRoot}",
  "parser": "claude-stream-json",
  "env": {},
  "checkFlags": ["--output-format", "--resume"],
  "supportsResume": true,
  "verified": true,
  "limits": "",
  "installHint": "How to install the program.",
  "loginHint": "How to sign in."
}
```

| Field | Meaning |
|---|---|
| `program` | The program's name, found on your `PATH`, or its full path. Settings can also hold a path per agent. |
| `args` | The arguments of every run. |
| `modelArgs`, `effortArgs`, `budgetArgs` | Added only when Settings gives a model, an effort level or a spending limit. `defaultModel` is the model used when Settings names none. |
| `resumeArgs` | Added when a turn continues an earlier session, as fix rounds and feedback do. |
| `resumeCommand` | The complete arguments for such a turn, for a program whose way of continuing does not fit after `args` (Codex: `exec resume <id> …`). |
| `stdin` | What is written to the program's standard input. Leave it out to keep standard input closed. |
| `parser` | Which parser reads the program's output: `claude-stream-json`, `codex-jsonl`, `gemini-stream-json`, `cursor-stream-json` or `pi-json`. |
| `checkFlags` | Flags that must appear in the program's help text. If one is missing, Settings warns that the installed version no longer matches the definition. |
| `verified` | `false` shows a note in Settings that the definition has not been confirmed with a real run. |
| `limits` | A sentence for Settings on how far the agent can be confined. Empty when the agent's own rules hold it to the folder it writes into. |

## Placeholders

| Placeholder | Replaced by |
|---|---|
| `{workspaceRoot}` | The project folder. |
| `{dotDirAbs}` | The project's `.codjiva` folder. |
| `{artifactDirAbs}` | The folder of the version being made. The agent should write only here. |
| `{jobDirAbs}` | The job's folder, which holds the prompt files, the schemas and the worked examples. |
| `{systemPromptPath}` | The file with the agent's instructions. |
| `{userPromptPath}`, `{userPromptText}` | The file with the task, and its text. |
| `{model}`, `{effort}`, `{sessionId}`, `{maxBudgetUsd}` | The values the optional argument groups need. |

A program that has no way to take a system prompt is given a short sentence that tells it to read the two files;
see `resources/adapters/cursor-agent.json`.

## What every agent must be able to do

- Read files anywhere in the project.
- Write files inside `{artifactDirAbs}`.
- Run without asking a person anything.
- Print its progress as one JSON object per line, in a format one of the parsers understands.

Codjiva does not rely on the agent to stay inside its folder. After every run it compares the project with a
snapshot taken before, and discards the result if anything else changed.
