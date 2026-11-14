// Command intake reads orders as JSON lines from standard input and submits
// each one to an orders.Handler.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"os"

	"example.com/orderintake/internal/orders"
)

// maxLineBytes is the longest input line the scanner accepts.
const maxLineBytes = 1 << 20

func main() {
	out := flag.String("out", "orders.jsonl", "file that accepted orders are appended to")
	flag.Parse()

	if err := run(os.Stdin, *out); err != nil {
		log.Printf("intake: %v", err)
		os.Exit(1)
	}
}

// run owns the lifetime of the store and the handler. It returns nil when
// all input was read, and an error when intake stopped early or the last
// flush failed.
func run(in io.Reader, outPath string) (err error) {
	store, err := orders.OpenFileStore(outPath)
	if err != nil {
		return err
	}
	defer store.Close()

	handler := orders.NewHandler(store, orders.NewLimiter())
	// This deferred call runs on every return path, including the return
	// for ErrOverloaded below. Close flushes the orders that are still in
	// memory. If run is otherwise successful, a failed flush becomes the
	// error that run returns.
	defer func() {
		if closeErr := handler.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
		logSummary(handler, store)
	}()

	tally := make(map[orders.Outcome]int)
	defer func() { log.Printf("intake: outcomes %v", tally) }()

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for scanner.Scan() {
		var o orders.Order
		if jsonErr := json.Unmarshal(scanner.Bytes(), &o); jsonErr != nil {
			log.Printf("intake: skipping unreadable line: %v", jsonErr)
			continue
		}

		outcome, submitErr := handler.Submit(o)
		tally[outcome]++
		switch {
		case errors.Is(submitErr, orders.ErrOverloaded):
			// The handler accepts no more orders. Reading stops here and
			// the rest of the input is left unread.
			return submitErr
		case errors.Is(submitErr, orders.ErrInvalid):
			log.Printf("intake: order %q rejected: %v", o.ID, submitErr)
		case submitErr != nil:
			log.Printf("intake: order %q not stored: %v", o.ID, submitErr)
		}
	}
	return scanner.Err()
}

// logSummary prints the final mode, the number of stored orders, and one
// line for every customer counter that records a deferred, blocked or shed
// order.
func logSummary(handler *orders.Handler, store *orders.FileStore) {
	mode, counts := handler.Snapshot()
	log.Printf("intake: final mode %d, %d orders stored", mode, store.Written())
	for key, n := range counts {
		switch key.Outcome {
		case orders.Deferred, orders.Blocked, orders.Shed:
			log.Printf("intake: customer %s %s=%d", key.CustomerID, key.Outcome, n)
		}
	}
}
