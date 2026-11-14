"""Limits, error types and the Bloom filter used by ingest.pipeline."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator

# Rejected rows in one file after which the file switches to RejectMode.SAMPLE.
REJECT_SOFT_LIMIT = 50
# Rejected rows in one file after which Pipeline.feed raises TooManyRejects.
REJECT_HARD_LIMIT = 500

# Memory used for deduplication at which the pipeline switches to DedupMode.BLOOM.
DEDUP_SOFT_BYTES = 256 * 1024 * 1024
# Memory used for deduplication at which Pipeline.feed raises IngestAborted.
DEDUP_HARD_BYTES = 384 * 1024 * 1024

# Size of one Bloom filter, and the number of keys it holds before it is full.
BLOOM_SEGMENT_BYTES = 8 * 1024 * 1024
BLOOM_SEGMENT_KEYS = 6_000_000
# Bit positions set for each key.
BLOOM_HASHES = 7

# Approximate memory a set uses for one key, not counting the key's characters.
KEY_OVERHEAD_BYTES = 120


class RowError(ValueError):
    """One row failed a processing step. The pipeline rejects the row and continues."""


class TooManyRejects(Exception):
    """One file has more than REJECT_HARD_LIMIT rejected rows. The file is abandoned."""

    def __init__(self, file_name: str, rejects: int) -> None:
        super().__init__(f"{file_name}: {rejects} rejected rows, limit is {REJECT_HARD_LIMIT}")
        self.file_name = file_name
        self.rejects = rejects


class IngestAborted(Exception):
    """Deduplication memory reached DEDUP_HARD_BYTES. The whole run stops."""

    def __init__(self, dedup_bytes: int) -> None:
        super().__init__(f"deduplication uses {dedup_bytes} bytes, limit is {DEDUP_HARD_BYTES}")
        self.dedup_bytes = dedup_bytes


def key_cost(key: str) -> int:
    """Estimates the memory, in bytes, that one key uses in a set."""
    return KEY_OVERHEAD_BYTES + len(key)


class BloomFilter:
    """A fixed-size set of keys that can report a key as present when it is not.

    It never reports a key that was added as absent. Its memory use is always
    BLOOM_SEGMENT_BYTES, no matter how many keys are added.
    """

    def __init__(self) -> None:
        self._bits = bytearray(BLOOM_SEGMENT_BYTES)
        self._keys = 0

    def _positions(self, key: str) -> Iterator[int]:
        """Yields the BLOOM_HASHES bit positions for a key."""
        digest = hashlib.blake2b(key.encode("utf-8"), digest_size=16).digest()
        first = int.from_bytes(digest[:8], "big")
        second = int.from_bytes(digest[8:], "big") | 1
        total_bits = BLOOM_SEGMENT_BYTES * 8
        for i in range(BLOOM_HASHES):
            yield (first + i * second) % total_bits

    def add(self, key: str) -> None:
        for position in self._positions(key):
            self._bits[position // 8] |= 1 << (position % 8)
        self._keys += 1

    def __contains__(self, key: str) -> bool:
        return all(self._bits[position // 8] & (1 << (position % 8)) for position in self._positions(key))

    def is_full(self) -> bool:
        """True once BLOOM_SEGMENT_KEYS keys were added. More keys would raise the false-positive rate."""
        return self._keys >= BLOOM_SEGMENT_KEYS
