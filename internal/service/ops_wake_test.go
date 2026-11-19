package service

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// RequestTick is called by the network monitor after every check round: it
// must never block the monitor, and requests that arrive before the worker
// wakes are merged into one pass.
func TestOpsService_RequestTickIsMergedAndNeverBlocks(t *testing.T) {
	s := NewOpsService(nil, nil, 0)

	s.RequestTick()
	s.RequestTick()
	s.RequestTick()

	select {
	case <-s.Wake():
	default:
		t.Fatal("a requested pass must wake the worker")
	}
	select {
	case <-s.Wake():
		t.Fatal("pending requests are merged into one pass")
	default:
	}

	// A service built without the constructor has no channel: still no block.
	assert.NotPanics(t, func() { (&OpsService{}).RequestTick() })
}
