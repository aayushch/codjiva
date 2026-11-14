"""CSV ingest pipeline. It routes rows, cleans them and writes them out in batches."""

from __future__ import annotations

import enum
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from .limits import (
    BLOOM_SEGMENT_BYTES,
    DEDUP_HARD_BYTES,
    DEDUP_SOFT_BYTES,
    REJECT_HARD_LIMIT,
    REJECT_SOFT_LIMIT,
    BloomFilter,
    IngestAborted,
    RowError,
    TooManyRejects,
    key_cost,
)
from .sink import Sink

# Rows in the in-memory batch at which the batch is written to the sink.
BATCH_SIZE = 500
# In RejectMode.SAMPLE, one rejected row out of this many is written to the reject file.
SAMPLE_EVERY = 10
# Column names in file order. A row that equals these names is a header row.
COLUMNS = ("tenant", "external_id", "email", "amount", "booked_on")
# Date formats accepted in the booked_on column.
DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y")


class Outcome(enum.Enum):
    """What Pipeline.feed did with one row."""

    SKIPPED_BLANK = "skipped-blank"
    DROPPED_HEADER = "dropped-header"
    ARCHIVED = "archived"
    REJECTED = "rejected"
    DUPLICATE = "duplicate"
    BATCHED = "batched"


class RejectMode(enum.Enum):
    """How rejected rows of the current file are recorded. begin_file resets it to KEEP_ALL."""

    KEEP_ALL = "keep-all"  # every rejected row is written to the reject file
    SAMPLE = "sample"  # one rejected row in SAMPLE_EVERY is written


class DedupMode(enum.Enum):
    """How duplicate rows are detected. The pipeline never returns from BLOOM to EXACT."""

    EXACT = "exact"  # every accepted key is stored in a set
    BLOOM = "bloom"  # new keys are stored in Bloom filters, which can report false duplicates


@dataclass
class Row:
    """One CSV row. feed() fills the first four fields and the processing steps fill the rest."""

    file_name: str
    line_no: int
    cells: list[str]
    tenant: str
    fields: dict[str, str] = field(default_factory=dict)
    amount_cents: int = 0
    key: str = ""


class Pipeline:
    """Takes CSV rows one at a time and writes the accepted rows to a Sink in batches.

    Use it as a context manager. When the with block ends, __exit__ writes the
    rows still in the batch and closes the sink. This also happens when an
    exception is leaving the with block.
    """

    def __init__(self, sink: Sink, archived_tenants: Iterable[str] = ()) -> None:
        self._sink = sink
        self._archived = {tenant.lower() for tenant in archived_tenants}
        self._batch: list[Row] = []
        # Per-tenant counters. The inner key is an Outcome value such as "rejected".
        self.tenant_counts: defaultdict[str, Counter[str]] = defaultdict(Counter)
        # Reject state of the file being read. begin_file resets all three.
        self._file_name = ""
        self._file_rejects = 0
        self.reject_mode = RejectMode.KEEP_ALL
        # Deduplication state. It covers all files of the run.
        self.dedup_mode = DedupMode.EXACT
        self._seen: set[str] = set()
        self._blooms: list[BloomFilter] = []
        self._dedup_bytes = 0

    def __enter__(self) -> Pipeline:
        return self

    def __exit__(self, exc_type, exc, traceback) -> bool:
        try:
            self._write_batch()
        finally:
            self._sink.close()
        return False  # an exception from the with block continues to the caller

    def begin_file(self, file_name: str) -> None:
        """Starts a new input file with a reject count of zero and RejectMode.KEEP_ALL."""
        self._file_name = file_name
        self._file_rejects = 0
        self.reject_mode = RejectMode.KEEP_ALL

    def end_file(self) -> None:
        """Writes the batch so that every accepted row of the file is on disk."""
        self._write_batch()

    def feed(self, cells: list[str], line_no: int) -> Outcome:
        """Entry point for one CSV row.

        - A row with only empty cells is skipped.
        - A row that repeats the header is dropped.
        - A row for an archived tenant is written to the archive file unchanged.
        - A row that fails parsing, normalising or validating is rejected.
        - A row whose key was already accepted is dropped as a duplicate.
        - Any other row is appended to the batch.

        Raises TooManyRejects when the file passes REJECT_HARD_LIMIT, and
        IngestAborted when deduplication memory reaches DEDUP_HARD_BYTES.
        """
        if not any(cell.strip() for cell in cells):
            return Outcome.SKIPPED_BLANK
        if tuple(cell.strip().lower() for cell in cells) == COLUMNS:
            return Outcome.DROPPED_HEADER

        row = Row(self._file_name, line_no, cells, tenant=cells[0].strip().lower())
        if row.tenant in self._archived:
            self._sink.write_archived(row)
            return self._count(row, Outcome.ARCHIVED)

        try:
            self._parse(row)
            self._normalise(row)
            self._validate(row)
        except RowError as error:
            return self._reject(row, str(error))
        if self._is_duplicate(row):
            return self._count(row, Outcome.DUPLICATE)

        self._batch.append(row)
        if len(self._batch) >= BATCH_SIZE:
            self._write_batch()
        return self._count(row, Outcome.BATCHED)

    def _parse(self, row: Row) -> None:
        """Step one. Stores the cells in row.fields under the names in COLUMNS."""
        if len(row.cells) != len(COLUMNS):
            raise RowError(f"expected {len(COLUMNS)} columns, found {len(row.cells)}")
        row.fields = dict(zip(COLUMNS, row.cells))

    def _normalise(self, row: Row) -> None:
        """Step two. Trims every field, lower-cases the email, converts the
        amount to whole cents and rewrites the date as YYYY-MM-DD."""
        fields = {name: value.strip() for name, value in row.fields.items()}
        fields["email"] = fields["email"].lower()
        try:
            row.amount_cents = int((Decimal(fields["amount"]) * 100).to_integral_value())
        except (ArithmeticError, ValueError):
            raise RowError(f"amount {fields['amount']!r} is not a number") from None
        fields["booked_on"] = _to_iso_date(fields["booked_on"])
        row.fields = fields

    def _validate(self, row: Row) -> None:
        """Step three. Checks the required fields and sets row.key, the value
        that identifies the row for deduplication."""
        if not row.tenant:
            raise RowError("tenant is empty")
        if not row.fields["external_id"]:
            raise RowError("external_id is empty")
        if "@" not in row.fields["email"]:
            raise RowError(f"email {row.fields['email']!r} has no @")
        if row.amount_cents < 0:
            raise RowError("amount is negative")
        row.key = f"{row.tenant}:{row.fields['external_id']}"

    def _is_duplicate(self, row: Row) -> bool:
        """Step four. Returns True if a row with the same key was accepted before.

        In DedupMode.EXACT the key is added to the set self._seen. In
        DedupMode.BLOOM the set is no longer changed and the key is added to
        the newest Bloom filter. A new Bloom filter is created when the newest
        one is full.
        """
        if row.key in self._seen:
            return True
        if self.dedup_mode is DedupMode.EXACT:
            self._seen.add(row.key)
            self._dedup_bytes += key_cost(row.key)
        else:
            if any(row.key in bloom for bloom in self._blooms):
                return True
            if self._blooms[-1].is_full():
                self._add_bloom_filter()
            self._blooms[-1].add(row.key)
        self._enforce_dedup_budget()
        return False

    def _enforce_dedup_budget(self) -> None:
        """Applies the global memory budget for deduplication.

        At DEDUP_SOFT_BYTES the pipeline switches from EXACT to BLOOM and
        creates the first Bloom filter. At DEDUP_HARD_BYTES it raises
        IngestAborted, which ends the whole run.
        """
        if self._dedup_bytes >= DEDUP_HARD_BYTES:
            raise IngestAborted(self._dedup_bytes)
        if self._dedup_bytes >= DEDUP_SOFT_BYTES and self.dedup_mode is DedupMode.EXACT:
            self.dedup_mode = DedupMode.BLOOM
            self._add_bloom_filter()

    def _add_bloom_filter(self) -> None:
        self._blooms.append(BloomFilter())
        self._dedup_bytes += BLOOM_SEGMENT_BYTES

    def _reject(self, row: Row, reason: str) -> Outcome:
        """Counts one rejected row for the current file and applies the per-file limits.

        Above REJECT_SOFT_LIMIT the file switches to RejectMode.SAMPLE. Above
        REJECT_HARD_LIMIT this method raises TooManyRejects. In KEEP_ALL mode
        the row is written to the reject file. In SAMPLE mode it is written
        only when the file's reject count is a multiple of SAMPLE_EVERY.
        """
        self._file_rejects += 1
        self._count(row, Outcome.REJECTED)
        if self._file_rejects > REJECT_HARD_LIMIT:
            raise TooManyRejects(self._file_name, self._file_rejects)
        if self._file_rejects > REJECT_SOFT_LIMIT:
            self.reject_mode = RejectMode.SAMPLE
        if self.reject_mode is RejectMode.KEEP_ALL or self._file_rejects % SAMPLE_EVERY == 0:
            self._sink.write_reject(row, reason)
        return Outcome.REJECTED

    def _write_batch(self) -> None:
        """Writes the batch to the sink and empties it. This runs when the batch
        reaches BATCH_SIZE, at the end of each file, and in __exit__."""
        if not self._batch:
            return
        self._sink.write_batch(self._batch)
        self._batch = []

    def _count(self, row: Row, outcome: Outcome) -> Outcome:
        """Adds one to the row's tenant counter for the outcome and returns the outcome."""
        self.tenant_counts[row.tenant][outcome.value] += 1
        return outcome


def _to_iso_date(text: str) -> str:
    """Returns the date in text as YYYY-MM-DD. Raises RowError if no format in DATE_FORMATS matches."""
    for date_format in DATE_FORMATS:
        try:
            return datetime.strptime(text, date_format).date().isoformat()
        except ValueError:
            continue
    raise RowError(f"booked_on {text!r} is not a date")
