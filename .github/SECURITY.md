# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| The latest release, and `main` | Yes |
| Older releases | No |

## Reporting a Vulnerability

If you discover a security vulnerability in Codjiva, please report it responsibly.
**Do not open a public GitHub issue.**

### How to Report

Email **aayush@live.in** with:

- A description of the vulnerability
- Steps to reproduce
- Affected component (core, builder, runtime, interface, Tauri shell, agent definitions, updater)
- Impact assessment (what an attacker could do)
- Any suggested fix, if you have one

### What to Expect

- **Acknowledgment** within 48 hours of your report
- **Status update** within 7 days with an assessment and timeline
- **Credit** in the release notes (unless you prefer to remain anonymous)

### Scope

The following are in scope:

- Artifact frame: a visual or film that reaches the app, the user's files or the network from inside its
  sandboxed frame
- Builder (`codjiva-build`): source files written by an agent that put markup or script into the built page
  past the builder's checks
- Core (`codjiva-core`): a path that leaves the workspace, a job that changes a saved version without being
  stopped, a changed source file that the write guard does not report
- Tauri shell (Rust): IPC commands, the `codjiva://` scheme, native API misuse
- Interface (Svelte): XSS, injection, data exposure
- Credential storage: API keys in the operating system's credential store, keys in logs or files
- Agent definitions and API providers: a definition or a provider answer that makes the app run a program or
  send data it should not
- Updater: an update that is installed without a valid signature

The following are out of scope:

- Vulnerabilities in upstream dependencies with no demonstrated exploit in Codjiva
- Vulnerabilities in an agent program or an API provider itself (Claude Code, Cursor Agent, Codex CLI, ...).
  Report those to their maker
- What an agent does inside the limits that Settings states for it. Some agents cannot be confined to one
  folder, and Settings says so
- Denial of service against the app on the user's own machine
- Social engineering

## Security Design

Codjiva is a **local** desktop application. Key security properties:

- **Writes stay in `.codjiva/`**: the app writes only inside `<project>/.codjiva/`, and an agent is told to
  write only into the folder of the version it is making
- **Write guard**: after every agent run the app compares the project with a snapshot taken before the run.
  It lists every file outside `.codjiva/` that changed, and stops a job that changed a saved version
- **Sandboxed artifacts**: a visual or film is shown in a frame that can run scripts and nothing else, with a
  policy that blocks every network request
- **Credentials** are stored in the operating system's credential store (Keychain, Credential Manager, Secret
  Service) or read from the provider's environment variable, never written to a file
- **No telemetry**: the app's own network requests are the calls to an API provider the user set up, and a
  request to GitHub for the newest release, which can be switched off
- **Signed updates**: the app installs an update only after checking its signature

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us reasonable time to address the issue before any
public disclosure. We aim to release fixes within 30 days of a confirmed vulnerability.
