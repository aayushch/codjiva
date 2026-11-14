# chunk-uploader
A command-line tool and library that uploads a large file to an HTTP endpoint in chunks.
Each chunk is hashed, compressed when that makes it smaller, signed, and sent in a small window of parallel requests.
Failed chunks are retried with backoff, and an in-flight byte budget slows or pauses the upload when the server falls behind.
Build with `npm run build`, then run `UPLOAD_SIGNING_KEY=... node dist/index.js <file> <endpoint>`.
