package scheduler

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeOpsTicker struct {
	ticks atomic.Int32
	wake  chan struct{}
}

func (f *fakeOpsTicker) Tick(context.Context) error {
	f.ticks.Add(1)
	return nil
}

func (f *fakeOpsTicker) Wake() <-chan struct{} { return f.wake }

// The worker runs a pass at start and then as soon as it is woken (the network
// monitor wakes it after every check round), without waiting for its timer.
func TestOpsWorker_RunsAPassWhenWoken(t *testing.T) {
	ticker := &fakeOpsTicker{wake: make(chan struct{}, 1)}
	worker := &OpsWorker{ops: ticker}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		worker.Run(ctx)
	}()

	require.Eventually(t, func() bool { return ticker.ticks.Load() == 1 }, 2*time.Second, 5*time.Millisecond, "the first pass runs at start")

	ticker.wake <- struct{}{}
	require.Eventually(t, func() bool { return ticker.ticks.Load() == 2 }, 2*time.Second, 5*time.Millisecond, "a wake-up runs a pass at once")

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the worker did not stop")
	}
	assert.EqualValues(t, 2, ticker.ticks.Load())
}

// Without a service the worker only waits for shutdown.
func TestOpsWorker_WithoutServiceWaitsForShutdown(t *testing.T) {
	worker := NewOpsWorker(nil)
	worker.startDelay = 0
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		worker.Run(ctx)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the worker did not stop")
	}
}
