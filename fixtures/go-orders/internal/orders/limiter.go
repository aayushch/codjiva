package orders

import "time"

const (
	// rateWindow is the length of the period over which a customer's orders
	// are counted.
	rateWindow = time.Minute
	// softOrdersPerWindow is the number of orders a customer may submit in
	// one window before further orders are deferred.
	softOrdersPerWindow = 30
	// hardOrdersPerWindow is the number of orders a customer may submit in
	// one window before the customer is blocked until the window ends.
	hardOrdersPerWindow = 60
)

// Verdict is the Limiter's decision for one order.
type Verdict int

const (
	// VerdictAllow means the order is processed now.
	VerdictAllow Verdict = iota
	// VerdictDefer means the customer is over softOrdersPerWindow. The order
	// is accepted but waits for the next tick of Handler.flushLoop.
	VerdictDefer
	// VerdictBlocked means the customer is over hardOrdersPerWindow. The
	// order is dropped.
	VerdictBlocked
)

// customerWindow counts one customer's orders in the current window.
type customerWindow struct {
	start   time.Time
	count   int
	blocked bool
}

// Limiter counts orders per customer in fixed windows of rateWindow.
// It has no lock of its own. Handler calls it while holding Handler.mu.
type Limiter struct {
	windows map[string]*customerWindow
}

// NewLimiter returns a Limiter with no customers recorded.
func NewLimiter() *Limiter {
	return &Limiter{windows: make(map[string]*customerWindow)}
}

// Allow records one order for the customer at time now and returns the
// verdict. A customer's window starts with the customer's first order and a
// new window starts with the first order after rateWindow has passed. Once a
// customer is blocked, every order is blocked until that window ends.
func (l *Limiter) Allow(customerID string, now time.Time) Verdict {
	w, ok := l.windows[customerID]
	if !ok || now.Sub(w.start) >= rateWindow {
		w = &customerWindow{start: now}
		l.windows[customerID] = w
	}
	if w.blocked {
		return VerdictBlocked
	}
	w.count++
	switch {
	case w.count > hardOrdersPerWindow:
		w.blocked = true
		return VerdictBlocked
	case w.count > softOrdersPerWindow:
		return VerdictDefer
	default:
		return VerdictAllow
	}
}

// Forget removes customers whose window ended before now, so that the map
// does not grow forever. Handler calls it on every tick of its flush loop.
func (l *Limiter) Forget(now time.Time) {
	for id, w := range l.windows {
		if now.Sub(w.start) >= rateWindow {
			delete(l.windows, id)
		}
	}
}
