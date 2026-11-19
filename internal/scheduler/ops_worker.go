package scheduler

import (
	"context"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/logger"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"

	"go.uber.org/zap"
)

// opsWorkerInterval is how often infrastructure events are collected and
// delivered when nothing wakes the worker earlier (the network monitor wakes
// it after every check round). The daily report is checked on the same tick.
const opsWorkerInterval = time.Minute

// opsWorkerBudget bounds one pass, so a slow Telegram cannot overlap ticks.
const opsWorkerBudget = 50 * time.Second

// opsWorkerStartDelay lets the network monitor finish its first round, so the
// first pass does not report servers as "unknown".
const opsWorkerStartDelay = 45 * time.Second

// opsTicker is the narrow contract the worker needs from OpsService.
type opsTicker interface {
	Tick(ctx context.Context) error
	// Wake signals that a pass is wanted right now.
	Wake() <-chan struct{}
}

var _ opsTicker = (*service.OpsService)(nil)

// OpsWorker periodically turns monitor outages and state changes into events,
// sends the daily report and delivers pending events to Telegram. Best-effort:
// a failed pass is logged and retried on the next tick.
type OpsWorker struct {
	ops        opsTicker
	startDelay time.Duration
}

// NewOpsWorker creates an OpsWorker. A nil service makes Run only wait for
// shutdown.
func NewOpsWorker(ops *service.OpsService) *OpsWorker {
	w := &OpsWorker{startDelay: opsWorkerStartDelay}
	if ops != nil {
		w.ops = ops
	}
	return w
}

// Run starts the periodic loop. It blocks until ctx is cancelled.
func (w *OpsWorker) Run(ctx context.Context) {
	logger.Info("Ops worker started", zap.String("interval", opsWorkerInterval.String()))

	select {
	case <-time.After(w.startDelay):
	case <-ctx.Done():
		logger.Info("Ops worker stopped")
		return
	}

	w.process(ctx)

	ticker := time.NewTicker(opsWorkerInterval)
	defer ticker.Stop()

	// A nil channel never fires: without a service only the timer runs.
	var wake <-chan struct{}
	if w.ops != nil {
		wake = w.ops.Wake()
	}

	for {
		select {
		case <-ticker.C:
			w.process(ctx)
		case <-wake:
			w.process(ctx)
		case <-ctx.Done():
			logger.Info("Ops worker stopped")
			return
		}
	}
}

func (w *OpsWorker) process(ctx context.Context) {
	if w.ops == nil {
		return
	}

	passCtx, cancel := context.WithTimeout(ctx, opsWorkerBudget)
	defer cancel()

	err := w.ops.Tick(passCtx)
	if err != nil && ctx.Err() == nil {
		logger.Warn("Ops pass finished with errors", zap.Error(err))
	}
}
