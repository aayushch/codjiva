// Package orders accepts customer orders, prices them and writes them to a
// Store in batches.
package orders

import (
	"errors"
	"fmt"
	"maps"
	"sync"
	"time"
)

const (
	maxBatch         = 64              // queued orders that cause an immediate flush
	flushInterval    = 2 * time.Second // period of the background flush
	softPendingBytes = 4 << 20         // pending bytes at which ModeShedding starts
	hardPendingBytes = 8 << 20         // pending bytes at which Submit returns ErrOverloaded
	lowValueCents    = 2500            // order totals below this are only counted in ModeShedding
	taxBasisPoints   = 825             // sales tax rate in hundredths of a percent
	orderBaseBytes   = 96              // estimated fixed memory cost of one Order
	orderLineBytes   = 48              // estimated memory cost of one Line
)

var (
	// ErrOverloaded means the pending-bytes budget is used up and intake has stopped.
	ErrOverloaded = errors.New("orders: pending bytes over hard budget")
	// ErrInvalid means the order is malformed and is not stored.
	ErrInvalid = errors.New("orders: invalid order")
)

// Order is the unit of work. The caller fills ID, CustomerID, Kind and Lines.
// The processing steps fill the remaining fields.
type Order struct {
	ID            string    `json:"id"`
	CustomerID    string    `json:"customer_id"`
	Kind          Kind      `json:"kind"`
	Lines         []Line    `json:"lines"`
	SubtotalCents int64     `json:"subtotal_cents"`
	TaxCents      int64     `json:"tax_cents"`
	TotalCents    int64     `json:"total_cents"`
	Sequence      uint64    `json:"sequence"`
	AcceptedAt    time.Time `json:"accepted_at"`
}

// sizeBytes estimates the memory an order uses while it waits to be written.
func (o *Order) sizeBytes() int64 {
	return int64(len(o.ID)+len(o.CustomerID)) + orderBaseBytes + int64(len(o.Lines))*orderLineBytes
}

// Mode is the load state of a Handler.
type Mode int

const (
	ModeNormal   Mode = iota // every valid order is stored
	ModeShedding             // low-value orders are only counted; the Handler never returns to ModeNormal
	ModeStopped              // every order is refused with ErrOverloaded
)

// Outcome says what Submit did with an order.
type Outcome int

const (
	Queued     Outcome = iota // processed and added to the batch
	WrittenNow                // priority order written to the Store at once
	Rejected                  // invalid, or refused because of an error
	Duplicate                 // an order with the same ID was already submitted
	Deferred                  // over the soft rate limit, held until the next tick
	Blocked                   // dropped, the customer is over the hard rate limit
	Shed                      // low-value order counted but not stored
)

func (o Outcome) String() string {
	return [...]string{"queued", "written-now", "rejected", "duplicate", "deferred", "blocked", "shed"}[o]
}

// CounterKey identifies one per-customer counter: how many of the customer's
// orders had the given outcome.
type CounterKey struct {
	CustomerID string
	Outcome    Outcome
}

// Handler receives orders, routes them and keeps the batch that waits to be
// written to the Store. All methods are safe for concurrent use.
type Handler struct {
	mu           sync.Mutex
	store        Store
	limiter      *Limiter
	mode         Mode
	batch        []Order             // processed orders waiting for a flush
	deferred     []Order             // processed orders held back by the soft rate limit
	pendingBytes int64               // estimated size of batch plus deferred
	seen         map[string]struct{} // order IDs already submitted
	counts       map[CounterKey]int  // per-customer outcome counters
	nextSequence uint64
	stop         chan struct{}
	loopDone     chan struct{}
	closeOnce    sync.Once
}

// NewHandler returns a Handler in ModeNormal and starts its flush loop.
// The caller must call Close to stop the loop and write the last batch.
func NewHandler(store Store, limiter *Limiter) *Handler {
	h := &Handler{
		store:    store,
		limiter:  limiter,
		seen:     make(map[string]struct{}),
		counts:   make(map[CounterKey]int),
		stop:     make(chan struct{}),
		loopDone: make(chan struct{}),
	}
	go h.flushLoop()
	return h
}

// Submit is the entry point for one order and returns what happened to it.
// The error wraps ErrInvalid for a malformed order and ErrOverloaded when the
// pending-bytes budget is used up. Any other error comes from the Store.
func (h *Handler) Submit(o Order) (Outcome, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.mode == ModeStopped {
		return Rejected, ErrOverloaded
	}
	if o.ID == "" || o.CustomerID == "" || len(o.Lines) == 0 {
		return Rejected, fmt.Errorf("%w: missing id, customer or lines", ErrInvalid)
	}
	if _, dup := h.seen[o.ID]; dup {
		return h.tally(o, Duplicate), nil
	}
	h.seen[o.ID] = struct{}{}

	verdict := h.limiter.Allow(o.CustomerID, time.Now())
	if verdict == VerdictBlocked {
		return h.tally(o, Blocked), nil
	}
	if err := h.process(&o); err != nil {
		return h.tally(o, Rejected), err
	}

	switch {
	case verdict == VerdictDefer:
		if err := h.reserve(o.sizeBytes()); err != nil {
			return h.tally(o, Rejected), err
		}
		h.deferred = append(h.deferred, o)
		return h.tally(o, Deferred), nil
	case o.Kind == KindPriority:
		if err := h.store.WriteBatch([]Order{o}); err != nil {
			delete(h.seen, o.ID) // the client may submit the same order again
			return h.tally(o, Rejected), err
		}
		return h.tally(o, WrittenNow), nil
	case h.mode == ModeShedding && o.TotalCents < lowValueCents:
		return h.tally(o, Shed), nil
	}
	return h.enqueue(o)
}

// process runs the three ordered steps that prepare an order for the Store.
func (h *Handler) process(o *Order) error {
	if err := validateLines(o); err != nil {
		return err
	}
	price(o)
	h.stamp(o)
	return nil
}

// validateLines is step one. It rejects a line with no SKU, no quantity or a negative price.
func validateLines(o *Order) error {
	for i, l := range o.Lines {
		if l.SKU == "" || l.Quantity <= 0 || l.UnitCents < 0 {
			return fmt.Errorf("%w: order %s line %d", ErrInvalid, o.ID, i)
		}
	}
	return nil
}

// price is step two. It fills SubtotalCents, TaxCents and TotalCents.
func price(o *Order) {
	o.SubtotalCents = 0
	for _, l := range o.Lines {
		o.SubtotalCents += int64(l.Quantity) * l.UnitCents
	}
	o.TaxCents = o.SubtotalCents * taxBasisPoints / 10_000
	o.TotalCents = o.SubtotalCents + o.TaxCents
}

// stamp is step three. It fills Sequence and AcceptedAt.
func (h *Handler) stamp(o *Order) {
	h.nextSequence++
	o.Sequence = h.nextSequence
	o.AcceptedAt = time.Now()
}

// enqueue adds a processed order to the batch and flushes the batch when it
// holds maxBatch orders. If that flush fails the order still counts as
// queued, because flushLocked keeps the batch in memory for the next flush.
func (h *Handler) enqueue(o Order) (Outcome, error) {
	if err := h.reserve(o.sizeBytes()); err != nil {
		return h.tally(o, Rejected), err
	}
	h.batch = append(h.batch, o)
	if len(h.batch) >= maxBatch {
		_ = h.flushLocked()
	}
	return h.tally(o, Queued), nil
}

// reserve adds n bytes to pendingBytes and applies the global budget.
// At softPendingBytes the Handler switches from ModeNormal to ModeShedding.
// At hardPendingBytes the Handler switches to ModeStopped, the bytes are not
// added, and reserve returns an error that wraps ErrOverloaded.
func (h *Handler) reserve(n int64) error {
	if h.pendingBytes+n >= hardPendingBytes {
		h.mode = ModeStopped
		return fmt.Errorf("%w: %d bytes pending", ErrOverloaded, h.pendingBytes)
	}
	h.pendingBytes += n
	if h.pendingBytes >= softPendingBytes && h.mode == ModeNormal {
		h.mode = ModeShedding
	}
	return nil
}

// flushLoop runs in its own goroutine. On every tick it moves the deferred
// orders into the batch and flushes the batch. It returns when Close closes
// the stop channel.
func (h *Handler) flushLoop() {
	defer close(h.loopDone)
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			h.mu.Lock()
			h.limiter.Forget(now)
			h.releaseDeferred()
			_ = h.flushLocked()
			h.mu.Unlock()
		case <-h.stop:
			return
		}
	}
}

// releaseDeferred moves every deferred order into the batch. The bytes of a
// deferred order are already part of pendingBytes. The caller must hold h.mu.
func (h *Handler) releaseDeferred() {
	h.batch = append(h.batch, h.deferred...)
	h.deferred = h.deferred[:0]
}

// flushLocked writes the whole batch to the Store. On success it empties
// the batch and releases its bytes. On failure the batch stays in memory so
// that the next flush writes it again. The caller must hold h.mu.
func (h *Handler) flushLocked() error {
	if len(h.batch) == 0 {
		return nil
	}
	if err := h.store.WriteBatch(h.batch); err != nil {
		return fmt.Errorf("orders: flush of %d orders: %w", len(h.batch), err)
	}
	for i := range h.batch {
		h.pendingBytes -= h.batch[i].sizeBytes()
	}
	h.batch = h.batch[:0]
	return nil
}

// Close stops the flush loop, moves the deferred orders into the batch and
// flushes the batch one last time. It also runs after ErrOverloaded, so the
// orders accepted before the error still reach the Store.
func (h *Handler) Close() error {
	h.closeOnce.Do(func() { close(h.stop) })
	<-h.loopDone
	h.mu.Lock()
	defer h.mu.Unlock()
	h.releaseDeferred()
	return h.flushLocked()
}

// Snapshot returns the current mode and a copy of the per-customer counters.
func (h *Handler) Snapshot() (Mode, map[CounterKey]int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.mode, maps.Clone(h.counts)
}

// tally adds one to the customer's counter for the outcome and returns the outcome.
func (h *Handler) tally(o Order, outcome Outcome) Outcome {
	h.counts[CounterKey{CustomerID: o.CustomerID, Outcome: outcome}]++
	return outcome
}
