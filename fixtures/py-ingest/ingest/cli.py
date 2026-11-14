"""Command-line entry point. It reads CSV files and feeds their rows to a Pipeline."""

from __future__ import annotations

import argparse
import csv
import sys
from collections.abc import Sequence
from pathlib import Path

from .limits import IngestAborted, TooManyRejects
from .pipeline import Pipeline
from .sink import Sink

EXIT_OK = 0
# At least one file was abandoned because it had too many rejected rows.
EXIT_PARTIAL = 1
# The run stopped before all files were read.
EXIT_ABORTED = 2


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="tenant-ingest", description="Load tenant billing CSV exports.")
    parser.add_argument("files", nargs="+", type=Path, help="CSV files to ingest, in order")
    parser.add_argument("--out-dir", type=Path, default=Path("out"), help="directory for the output files")
    parser.add_argument(
        "--archived",
        default="",
        help="comma-separated tenants whose rows go to archived.csv",
    )
    return parser.parse_args(argv)


def ingest_file(pipeline: Pipeline, path: Path) -> bool:
    """Feeds every row of one CSV file to the pipeline.

    Returns True if the whole file was read. Returns False if the pipeline
    raised TooManyRejects, in which case the rest of the file is not read and
    the caller continues with the next file. The finally block calls
    pipeline.end_file() in both cases, so rows accepted from this file are
    written before the next file starts. IngestAborted is not handled here.
    """
    pipeline.begin_file(path.name)
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            for line_no, cells in enumerate(csv.reader(handle), start=1):
                pipeline.feed(cells, line_no)
    except TooManyRejects as error:
        print(f"ingest: abandoned file, {error}", file=sys.stderr)
        return False
    finally:
        pipeline.end_file()
    return True


def _report(pipeline: Pipeline) -> None:
    """Prints the final deduplication mode and one line of counters per tenant."""
    print(f"ingest: dedup mode {pipeline.dedup_mode.value}", file=sys.stderr)
    for tenant, counts in sorted(pipeline.tenant_counts.items()):
        summary = ", ".join(f"{name}={count}" for name, count in sorted(counts.items()))
        print(f"ingest: tenant {tenant or '(none)'}: {summary}", file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    """Runs one ingest and returns the process exit code.

    The pipeline is used as a context manager. If IngestAborted leaves the
    with block, Pipeline.__exit__ has already written the batch and closed
    the sink by the time the except clause runs.
    """
    args = _parse_args(argv)
    archived = [tenant.strip() for tenant in args.archived.split(",") if tenant.strip()]
    abandoned: list[str] = []

    pipeline = Pipeline(Sink(args.out_dir), archived_tenants=archived)
    try:
        with pipeline:
            for path in args.files:
                if not ingest_file(pipeline, path):
                    abandoned.append(path.name)
    except IngestAborted as error:
        print(f"ingest: aborted, {error}", file=sys.stderr)
        _report(pipeline)
        return EXIT_ABORTED

    _report(pipeline)
    if abandoned:
        print(f"ingest: abandoned files: {', '.join(abandoned)}", file=sys.stderr)
        return EXIT_PARTIAL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
