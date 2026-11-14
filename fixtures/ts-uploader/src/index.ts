#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

import { RetryExhaustedError } from "./retry";
import { HttpTransport } from "./transport";
import { BackpressureError, type Chunk, type ProgressEvent, Uploader } from "./uploader";

/** Size of the pieces the file is read in, in bytes. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;
/** The upload stopped early or left chunks unsent. Running the command again continues it. */
const EXIT_INCOMPLETE = 75;

/** Reads the file in pieces of CHUNK_BYTES and numbers them from zero. */
async function* readChunks(filePath: string): AsyncGenerator<Chunk> {
  let index = 0;
  for await (const data of createReadStream(filePath, { highWaterMark: CHUNK_BYTES })) {
    yield { index, data: data as Buffer };
    index += 1;
  }
}

function logProgress(event: ProgressEvent): void {
  if (event.type === "mode-changed") {
    console.error(`upload: switched to ${event.mode} mode`);
  } else if (event.type === "retry-scheduled") {
    console.error(`upload: chunk ${event.index} failed ${event.attempts} times, next try in ${event.delayMs} ms`);
  }
}

/**
 * Runs one upload from start to finish and returns the process exit code.
 * This function owns the Uploader and handles the two errors that end an
 * upload early.
 *
 * - BackpressureError: the server is not keeping up. Uploader.run has already
 *   flushed what it held, so the result is EXIT_INCOMPLETE.
 * - RetryExhaustedError: one chunk failed too often. The result is EXIT_FAILED.
 *
 * Any other error is not expected and is thrown to the caller.
 */
async function main(argv: string[]): Promise<number> {
  const [filePath, endpoint] = argv;
  const signingKey = process.env.UPLOAD_SIGNING_KEY;
  if (filePath === undefined || endpoint === undefined || signingKey === undefined) {
    console.error("usage: UPLOAD_SIGNING_KEY=<key> chunk-upload <file> <endpoint>");
    return EXIT_USAGE;
  }

  // The same file gets the same upload id on every run, so the server can
  // match chunks from an interrupted run with chunks from this one.
  const stats = statSync(filePath);
  const uploadId = `${basename(filePath)}-${stats.size}-${Math.trunc(stats.mtimeMs)}`;

  const uploader = new Uploader({
    uploadId,
    signingKey: Buffer.from(signingKey, "utf8"),
    transport: new HttpTransport(endpoint),
  });
  const unsubscribe = uploader.subscribe(logProgress);

  try {
    const summary = await uploader.run(readChunks(filePath));
    console.error(`upload: ${summary.acknowledgedChunks} chunks, ${summary.acknowledgedBytes} bytes acknowledged`);
    if (summary.unsentChunks > 0) {
      console.error(`upload: ${summary.unsentChunks} chunks were not acknowledged`);
      return EXIT_INCOMPLETE;
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof BackpressureError) {
      console.error(`upload: paused, ${error.message}`);
      return EXIT_INCOMPLETE;
    }
    if (error instanceof RetryExhaustedError) {
      console.error(`upload: failed, ${error.message}`);
      return EXIT_FAILED;
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = EXIT_FAILED;
  },
);
