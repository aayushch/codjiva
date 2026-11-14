# Fixtures

Small workspaces used to test Codjiva.

`private/` is git-ignored and must stay that way. It holds proprietary source code copied in for
local testing only. Nothing under it may ever be committed, published or attached to an issue.
A pre-commit hook in this clone (`.git/hooks/pre-commit`) refuses any commit that includes it.
The hook is not part of the repository, so a fresh clone does not have it; the `.gitignore`
rule is what protects a fresh clone.

## The four language fixtures

Each one is a small, made-up program with the shape Codjiva is meant to explain: a unit of work
enters, is routed, goes through ordered steps, is batched, and is limited by a soft and a hard
level. They have no dependencies beyond their language's standard library.

| Folder | Language | File to visualise |
|---|---|---|
| `go-orders/` | Go | `internal/orders/handler.go` |
| `cpp-logbuf/` | C++ | `src/LogWriter.cpp` |
| `ts-uploader/` | TypeScript | `src/uploader.ts` |
| `py-ingest/` | Python | `ingest/pipeline.py` |

A job writes a `.codjiva` folder into the workspace it runs on. Run jobs on a copy of a fixture,
never on the fixture itself:

    cp -R fixtures/go-orders /tmp/go-orders
    VISUALISE=internal/orders/handler.go LIMIT_SECONDS=1200 scripts/selfcheck.sh /tmp/go-orders /tmp/go-orders-out

## Recorded sessions

`replay/` holds recordings of real agent runs on the Go fixture, made with `scripts/record-replay.sh`:
a visual (`go-orders-visual`), a film (`go-orders-film`) and a pipeline of two visuals
(`go-orders-pipeline`). The script keeps only what the app shows of the agent's output, with
paths made relative, so a recording names no folder of the machine it was made on. The app plays
one back in place of an agent when `CODJIVA_REPLAY_DIR` names its folder, so the whole job
pipeline can be tested without an agent, a network connection or any cost.
