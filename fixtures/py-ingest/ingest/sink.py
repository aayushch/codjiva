"""Output files for ingest.pipeline."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import IO, TYPE_CHECKING

if TYPE_CHECKING:
    from .pipeline import Row

ACCEPTED_FILE = "accepted.csv"
ARCHIVED_FILE = "archived.csv"
REJECTS_FILE = "rejects.csv"

ACCEPTED_HEADER = ("tenant", "external_id", "email", "amount_cents", "booked_on")
REJECTS_HEADER = ("file", "line", "reason", "cells")


class Sink:
    """Writes the pipeline's output to three CSV files in one directory.

    - accepted.csv receives the cleaned rows, one batch at a time.
    - archived.csv receives the untouched cells of rows for archived tenants.
    - rejects.csv receives rows that failed a processing step, with the reason.
    """

    def __init__(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        self._handles: list[IO[str]] = []
        self._accepted = self._open(out_dir / ACCEPTED_FILE, ACCEPTED_HEADER)
        self._accepted_handle = self._handles[0]
        self._archived = self._open(out_dir / ARCHIVED_FILE, None)
        self._rejects = self._open(out_dir / REJECTS_FILE, REJECTS_HEADER)
        self.rows_written = 0

    def _open(self, path: Path, header: tuple[str, ...] | None):
        """Opens a file for appending and writes the header if the file is new."""
        is_new = not path.exists() or path.stat().st_size == 0
        handle = path.open("a", newline="", encoding="utf-8")
        self._handles.append(handle)
        writer = csv.writer(handle)
        if is_new and header is not None:
            writer.writerow(header)
        return writer

    def write_batch(self, rows: list[Row]) -> None:
        """Writes one batch of accepted rows and flushes the file to disk."""
        self._accepted.writerows(
            (
                row.tenant,
                row.fields["external_id"],
                row.fields["email"],
                row.amount_cents,
                row.fields["booked_on"],
            )
            for row in rows
        )
        self._accepted_handle.flush()
        self.rows_written += len(rows)

    def write_archived(self, row: Row) -> None:
        """Writes the original cells of a row that belongs to an archived tenant."""
        self._archived.writerow(row.cells)

    def write_reject(self, row: Row, reason: str) -> None:
        """Writes one rejected row with its file, line number and the reason."""
        self._rejects.writerow((row.file_name, row.line_no, reason, "|".join(row.cells)))

    def close(self) -> None:
        """Closes all three files. Calling it a second time does nothing."""
        for handle in self._handles:
            handle.close()
        self._handles = []
