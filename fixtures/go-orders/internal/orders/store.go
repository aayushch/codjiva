package orders

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Kind says how urgently an order must reach the Store.
type Kind string

const (
	// KindStandard orders wait in the Handler's batch.
	KindStandard Kind = "standard"
	// KindPriority orders are written as soon as they are processed.
	KindPriority Kind = "priority"
)

// Line is one product line of an Order.
type Line struct {
	SKU       string `json:"sku"`
	Quantity  int    `json:"quantity"`
	UnitCents int64  `json:"unit_cents"`
}

// Store is where the Handler writes orders. WriteBatch either stores every
// order in the slice or returns an error and stores none of them.
type Store interface {
	WriteBatch(orders []Order) error
	Close() error
}

// FileStore appends orders to a file, one JSON object per line.
type FileStore struct {
	mu      sync.Mutex
	file    *os.File
	written int
}

// OpenFileStore opens the file at path for appending and creates it if it
// does not exist.
func OpenFileStore(path string) (*FileStore, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("orders: open store %s: %w", path, err)
	}
	return &FileStore{file: f}, nil
}

// WriteBatch encodes all orders into one buffer, appends the buffer to the
// file with a single write and syncs the file to disk. An order that cannot
// be encoded fails the whole batch before anything is written.
func (s *FileStore) WriteBatch(orders []Order) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for i := range orders {
		if err := enc.Encode(&orders[i]); err != nil {
			return fmt.Errorf("orders: encode order %s: %w", orders[i].ID, err)
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.file.Write(buf.Bytes()); err != nil {
		return fmt.Errorf("orders: write batch: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		return fmt.Errorf("orders: sync batch: %w", err)
	}
	s.written += len(orders)
	return nil
}

// Written returns the number of orders stored so far.
func (s *FileStore) Written() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.written
}

// Close closes the underlying file.
func (s *FileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.file.Close()
}
