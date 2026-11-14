import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";

import { decideRetry, RetryExhaustedError } from "./retry";
import { type OutboundChunk, TransientSendError, type Transport } from "./transport";

/** Prepared chunks in the send window at which enqueue flushes the window. */
export const WINDOW_SIZE = 8;
/** How often the timer in run() flushes the send window, in milliseconds. */
export const FLUSH_INTERVAL_MS = 1_000;
/** Chunks sent at the same time while the uploader is in LaneMode.Parallel. */
export const PARALLEL_LANES = 4;
/** In-flight bytes above which the uploader switches to LaneMode.SingleLane. */
export const SOFT_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
/** In-flight bytes above which enqueue pauses intake and throws BackpressureError. */
export const HARD_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
/** Chunks smaller than this many bytes are sent without compression. */
export const MIN_COMPRESS_BYTES = 1_024;

/** One piece of the file, as the caller read it. Uploader.enqueue turns it into an OutboundChunk. */
export interface Chunk {
  index: number;
  data: Buffer;
}

/** How many chunks the uploader sends at the same time. */
export enum LaneMode {
  /** Up to PARALLEL_LANES chunks at once. */
  Parallel = "parallel",
  /** One chunk at a time. The uploader never returns from SingleLane to Parallel. */
  SingleLane = "single-lane",
}

export type EnqueueOutcome = "queued" | "skipped-empty" | "deduplicated";
export type FlushReason = "window-full" | "timer" | "final";

export type ProgressEvent =
  | { type: "acknowledged"; index: number; acknowledgedBytes: number }
  | { type: "retry-scheduled"; index: number; attempts: number; delayMs: number }
  | { type: "mode-changed"; mode: LaneMode }
  | { type: "flushed"; reason: FlushReason; attempted: number };
export type ProgressListener = (event: ProgressEvent) => void;

export interface UploadSummary {
  acknowledgedChunks: number;
  acknowledgedBytes: number;
  /** Chunks still in the send window because their last send failed. */
  unsentChunks: number;
}

/** Thrown by Uploader.enqueue while intake is paused by the in-flight byte budget. */
export class BackpressureError extends Error {
  constructor(readonly inFlightBytes: number) {
    super(`upload intake is paused with ${inFlightBytes} bytes in flight`);
    this.name = "BackpressureError";
  }
}

export interface UploaderOptions {
  uploadId: string;
  signingKey: Buffer;
  transport: Transport;
  /** Chunk indexes the server acknowledged in an earlier run of the same upload. */
  alreadyAcknowledged?: Iterable<number>;
}

export class Uploader {
  private mode = LaneMode.Parallel;
  private intakePaused = false;
  private inFlightBytes = 0; // raw bytes of all chunks in the send window
  private acknowledgedBytes = 0;
  private activeFlush: Promise<void> | undefined;
  private fatal: Error | undefined; // the error that ended the upload, if any
  private readonly window: OutboundChunk[] = []; // prepared chunks the server has not acknowledged
  private readonly acknowledged: Set<number>;
  private readonly retries = new Map<number, number>(); // failed attempts, keyed by chunk index
  private readonly listeners = new Set<ProgressListener>();

  constructor(private readonly options: UploaderOptions) {
    this.acknowledged = new Set(options.alreadyAcknowledged ?? []);
  }

  /** Registers a progress listener and returns a function that removes it. */
  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Uploads every chunk from `source`. A timer flushes the send window every
   * FLUSH_INTERVAL_MS. The finally block runs when the source ends and also
   * when enqueue throws. It stops the timer, flushes the window one last time
   * unless the upload has already failed, and closes the transport.
   */
  async run(source: AsyncIterable<Chunk>): Promise<UploadSummary> {
    // flushWindow stores a failure in this.fatal, and enqueue and run throw
    // it from there, so the rejected promise of a timer flush is ignored.
    const timer = setInterval(() => void this.flushWindow("timer").catch(() => undefined), FLUSH_INTERVAL_MS);
    try {
      for await (const chunk of source) {
        await this.enqueue(chunk);
      }
    } finally {
      clearInterval(timer);
      if (this.fatal === undefined) {
        await this.flushWindow("final").catch(() => undefined);
      }
      await this.options.transport.close();
    }
    if (this.fatal !== undefined) {
      throw this.fatal;
    }
    return {
      acknowledgedChunks: this.acknowledged.size,
      acknowledgedBytes: this.acknowledgedBytes,
      unsentChunks: this.window.length,
    };
  }

  /**
   * Entry point for one chunk.
   *
   * - An empty chunk is skipped.
   * - A chunk whose index the server has already acknowledged is not sent again.
   * - Any other chunk is hashed, compressed, signed and added to the send window.
   *
   * Throws BackpressureError while intake is paused, and the stored error if
   * an earlier flush ended the upload.
   */
  async enqueue(chunk: Chunk): Promise<EnqueueOutcome> {
    if (this.fatal !== undefined) {
      throw this.fatal;
    }
    if (chunk.data.length === 0) {
      return "skipped-empty";
    }
    if (this.acknowledged.has(chunk.index)) {
      return "deduplicated";
    }
    this.admit(chunk.data.length);

    const outbound: OutboundChunk = {
      index: chunk.index,
      rawBytes: chunk.data.length,
      digest: "",
      body: chunk.data,
      encoding: "identity",
      signature: "",
      notBefore: 0,
    };
    this.hash(outbound);
    this.compress(outbound);
    this.sign(outbound);

    this.window.push(outbound);
    this.inFlightBytes += outbound.rawBytes;
    if (this.window.length >= WINDOW_SIZE) {
      await this.flushWindow("window-full");
    }
    return "queued";
  }

  /**
   * Applies the in-flight byte budget before a chunk of `bytes` bytes is accepted.
   * Above SOFT_IN_FLIGHT_BYTES the uploader switches to LaneMode.SingleLane.
   * Above HARD_IN_FLIGHT_BYTES intake is paused and BackpressureError is thrown.
   * Intake stays paused until acknowledge() resumes it.
   */
  private admit(bytes: number): void {
    const projected = this.inFlightBytes + bytes;
    if (projected > HARD_IN_FLIGHT_BYTES) {
      this.intakePaused = true;
    }
    if (this.intakePaused) {
      throw new BackpressureError(this.inFlightBytes);
    }
    if (projected > SOFT_IN_FLIGHT_BYTES && this.mode === LaneMode.Parallel) {
      this.mode = LaneMode.SingleLane;
      this.notify({ type: "mode-changed", mode: this.mode });
    }
  }

  /** Step one. Sets digest to the SHA-256 of the uncompressed chunk data. */
  private hash(chunk: OutboundChunk): void {
    chunk.digest = createHash("sha256").update(chunk.body).digest("hex");
  }

  /** Step two. Replaces body with its gzip form when the chunk is large enough and gzip makes it smaller. */
  private compress(chunk: OutboundChunk): void {
    if (chunk.rawBytes < MIN_COMPRESS_BYTES) {
      return;
    }
    const zipped = gzipSync(chunk.body);
    if (zipped.length < chunk.body.length) {
      chunk.body = zipped;
      chunk.encoding = "gzip";
    }
  }

  /** Step three. Signs the upload id, chunk index, digest and encoding with the signing key. */
  private sign(chunk: OutboundChunk): void {
    const signedText = `${this.options.uploadId}:${chunk.index}:${chunk.digest}:${chunk.encoding}`;
    chunk.signature = createHmac("sha256", this.options.signingKey).update(signedText).digest("hex");
  }

  /**
   * Sends the chunks in the window. Only one flush runs at a time. A "timer"
   * flush does nothing if another flush is running. A "window-full" or "final"
   * flush waits for the running flush first. An error is stored in this.fatal
   * and thrown.
   */
  private async flushWindow(reason: FlushReason): Promise<void> {
    while (this.activeFlush !== undefined) {
      if (reason === "timer") {
        return;
      }
      await this.activeFlush;
    }
    this.activeFlush = this.sendDue(reason);
    try {
      await this.activeFlush;
    } catch (error) {
      this.fatal = error instanceof Error ? error : new Error(String(error));
      throw this.fatal;
    } finally {
      this.activeFlush = undefined;
    }
  }

  /**
   * Sends every chunk in the window whose notBefore time has passed. The
   * "final" flush ignores notBefore and sends all chunks. Chunks are sent
   * PARALLEL_LANES at a time in LaneMode.Parallel and one at a time in SingleLane.
   */
  private async sendDue(reason: FlushReason): Promise<void> {
    const now = Date.now();
    const due = this.window.filter((chunk) => reason === "final" || chunk.notBefore <= now);
    const lanes = this.mode === LaneMode.SingleLane ? 1 : PARALLEL_LANES;
    for (let start = 0; start < due.length; start += lanes) {
      await Promise.all(due.slice(start, start + lanes).map((chunk) => this.sendOne(chunk)));
    }
    this.notify({ type: "flushed", reason, attempted: due.length });
  }

  /**
   * Sends one chunk. On TransientSendError the chunk stays in the window and
   * a retry is scheduled. Any other transport error ends the upload.
   */
  private async sendOne(chunk: OutboundChunk): Promise<void> {
    try {
      await this.options.transport.send(this.options.uploadId, chunk);
    } catch (error) {
      if (!(error instanceof TransientSendError)) {
        throw error;
      }
      this.scheduleRetry(chunk);
      return;
    }
    this.acknowledge(chunk);
  }

  /**
   * Counts one more failed attempt for the chunk. At the hard retry limit it
   * throws RetryExhaustedError, which ends the upload. Below that limit it
   * sets the chunk's notBefore to now plus the backoff delay from decideRetry.
   */
  private scheduleRetry(chunk: OutboundChunk): void {
    const attempts = (this.retries.get(chunk.index) ?? 0) + 1;
    this.retries.set(chunk.index, attempts);
    const decision = decideRetry(attempts);
    if (decision.giveUp) {
      throw new RetryExhaustedError(chunk.index, attempts);
    }
    chunk.notBefore = Date.now() + decision.delayMs;
    this.notify({ type: "retry-scheduled", index: chunk.index, attempts, delayMs: decision.delayMs });
  }

  /** Removes an acknowledged chunk from the window, releases its bytes and resumes paused intake if the budget allows. */
  private acknowledge(chunk: OutboundChunk): void {
    this.window.splice(this.window.indexOf(chunk), 1);
    this.acknowledged.add(chunk.index);
    this.inFlightBytes -= chunk.rawBytes;
    this.acknowledgedBytes += chunk.rawBytes;
    if (this.intakePaused && this.inFlightBytes <= SOFT_IN_FLIGHT_BYTES) {
      this.intakePaused = false;
    }
    this.notify({ type: "acknowledged", index: chunk.index, acknowledgedBytes: this.acknowledgedBytes });
  }

  private notify(event: ProgressEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
