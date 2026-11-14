/**
 * A chunk prepared for sending. Uploader.enqueue creates it from a Chunk, and
 * its three processing steps fill digest, then body and encoding, then signature.
 */
export interface OutboundChunk {
  index: number;
  /** Size of the chunk before compression, in bytes. */
  rawBytes: number;
  /** SHA-256 of the uncompressed data, as hex. */
  digest: string;
  body: Buffer;
  encoding: "identity" | "gzip";
  signature: string;
  /** Earliest time, in milliseconds since the epoch, at which the chunk may be sent. */
  notBefore: number;
}

/** How long one chunk request may take before it is aborted, in milliseconds. */
export const SEND_TIMEOUT_MS = 15_000;

/** A send failed in a way that may succeed on a later attempt. The uploader retries it. */
export class TransientSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientSendError";
  }
}

/** The server refused the chunk for good. The uploader does not retry it. */
export class PermanentSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PermanentSendError";
  }
}

/** Sends prepared chunks to the server. Uploader calls send for every chunk in its window. */
export interface Transport {
  /** Resolves when the server has acknowledged the chunk. */
  send(uploadId: string, chunk: OutboundChunk): Promise<void>;
  /** Releases the transport. Uploader.run calls it once, after the last flush. */
  close(): Promise<void>;
}

/** Sends each chunk as one HTTP PUT request to `<baseUrl>/uploads/<uploadId>/chunks/<index>`. */
export class HttpTransport implements Transport {
  private closed = false;

  constructor(private readonly baseUrl: string) {}

  /**
   * Sends one chunk. The outcome depends on what the server does.
   *
   * - A 2xx response resolves the promise.
   * - A network failure, a timeout, a 429 or a 5xx response throws TransientSendError.
   * - Any other response throws PermanentSendError.
   */
  async send(uploadId: string, chunk: OutboundChunk): Promise<void> {
    if (this.closed) {
      throw new PermanentSendError("transport is closed", 0);
    }
    const url = `${this.baseUrl}/uploads/${encodeURIComponent(uploadId)}/chunks/${chunk.index}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": chunk.encoding,
          "x-chunk-digest": chunk.digest,
          "x-chunk-signature": chunk.signature,
        },
        body: chunk.body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new TransientSendError(`chunk ${chunk.index}: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new TransientSendError(`chunk ${chunk.index}: server responded with ${response.status}`);
    }
    if (!response.ok) {
      throw new PermanentSendError(`chunk ${chunk.index}: server responded with ${response.status}`, response.status);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
