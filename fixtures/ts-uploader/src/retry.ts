/** Failed attempts for one chunk after which every further delay is doubled. */
export const SOFT_RETRY_LIMIT = 3;

/** Failed attempts for one chunk at which the whole upload fails. */
export const HARD_RETRY_LIMIT = 6;

/** Delay before the first retry of a chunk, in milliseconds. */
export const BASE_BACKOFF_MS = 250;

/** Longest delay between two attempts for the same chunk, in milliseconds. */
export const MAX_BACKOFF_MS = 30_000;

/** What the uploader does after a chunk failed to send. */
export interface RetryDecision {
  /** True when the chunk has used all its attempts and the upload must fail. */
  giveUp: boolean;
  /** How long to wait before the chunk is sent again. Zero when giveUp is true. */
  delayMs: number;
}

/**
 * Thrown when one chunk has failed HARD_RETRY_LIMIT times. The upload cannot
 * finish without that chunk, so the error ends the whole upload.
 */
export class RetryExhaustedError extends Error {
  constructor(
    readonly chunkIndex: number,
    readonly attempts: number,
  ) {
    super(`chunk ${chunkIndex} failed ${attempts} times; upload abandoned`);
    this.name = "RetryExhaustedError";
  }
}

/**
 * Decides what happens after the given number of failed attempts for one chunk.
 *
 * - At HARD_RETRY_LIMIT or more, the decision is to give up.
 * - Otherwise the delay starts at BASE_BACKOFF_MS and doubles with each attempt.
 * - Above SOFT_RETRY_LIMIT that delay is doubled once more, because a chunk
 *   that keeps failing usually means the server is overloaded.
 * - The delay never exceeds MAX_BACKOFF_MS.
 */
export function decideRetry(attempts: number): RetryDecision {
  if (attempts >= HARD_RETRY_LIMIT) {
    return { giveUp: true, delayMs: 0 };
  }
  let delayMs = BASE_BACKOFF_MS * 2 ** (attempts - 1);
  if (attempts > SOFT_RETRY_LIMIT) {
    delayMs *= 2;
  }
  return { giveUp: false, delayMs: Math.min(delayMs, MAX_BACKOFF_MS) };
}
