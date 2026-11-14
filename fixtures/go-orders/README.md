# order-intake
An order intake service that reads customer orders as JSON lines on standard input.
Each order is checked, priced, given a sequence number and written to a JSON-lines file in batches.
Per-customer rate limits and a pending-bytes budget protect the service when the store is slow.
Run it with `go run ./cmd/intake -out orders.jsonl < orders.ndjson`.
