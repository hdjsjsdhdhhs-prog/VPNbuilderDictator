package web

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/netmon"
)

// NetworkMonitor is the read side of the network monitor behind the
// "Мониторинг" page. *netmon.Service implements it.
type NetworkMonitor interface {
	Overview(ctx context.Context) (*netmon.Overview, error)
	BuilderDetail(ctx context.Context, id uint) (*netmon.BuilderDetail, error)
	History(ctx context.Context, q netmon.HistoryQuery) (*netmon.History, error)
	// CheckNow runs one resolution and check round right away.
	CheckNow(ctx context.Context) error
}

var _ NetworkMonitor = (*netmon.Service)(nil)

const adminMonitoringMaxCountry = 8

// adminMonitoringCheckBudget bounds a manual check: it fetches the sources of
// every enabled builder and probes their servers.
const adminMonitoringCheckBudget = 25 * time.Second

// routeMonitoring serves the read-only monitor API:
//
//	GET /admin/api/monitoring                 builders overview
//	GET /admin/api/monitoring/builders/{id}   countries and servers of a builder
//	GET /admin/api/monitoring/history         ?builder_id=&country=&target_id=&period=24h|7d|30d
//	POST /admin/api/monitoring/check          run a check round now, answer the overview
//
// Reading never triggers a check: checks run in the background worker and on
// the explicit POST above.
func (a *adminAPI) routeMonitoring(w http.ResponseWriter, r *http.Request, segments []string) {
	if a.monitor == nil {
		writeAdminError(w, http.StatusServiceUnavailable, "service_unavailable")
		return
	}
	switch {
	case len(segments) == 1:
		a.get(w, r, a.monitoringOverview)
	case len(segments) == 2 && segments[1] == "history":
		a.get(w, r, a.monitoringHistory)
	case len(segments) == 2 && segments[1] == "check":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeAdminError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		a.monitoringCheck(w, r)
	case len(segments) == 3 && segments[1] == "builders":
		id, ok := parseAdminID(segments[2])
		if !ok {
			writeAdminError(w, http.StatusNotFound, "not_found")
			return
		}
		a.get(w, r, func(w http.ResponseWriter, r *http.Request) { a.monitoringBuilder(w, r, id) })
	default:
		writeAdminError(w, http.StatusNotFound, "not_found")
	}
}

func (a *adminAPI) monitoringOverview(w http.ResponseWriter, r *http.Request) {
	out, err := a.monitor.Overview(r.Context())
	if err != nil {
		a.internal(w, "monitoring_overview", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, out)
}

// monitoringCheck is POST /admin/api/monitoring/check: re-resolve the builders,
// probe every served server once and answer the fresh overview. The body must
// be empty or "{}". 409 check_in_progress while a pass is already running.
func (a *adminAPI) monitoringCheck(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64))
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if body := strings.TrimSpace(string(raw)); body != "" && body != "{}" {
		writeAdminError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), adminMonitoringCheckBudget)
	defer cancel()
	err = a.monitor.CheckNow(ctx)
	if err != nil {
		if errors.Is(err, netmon.ErrCheckInProgress) {
			writeAdminError(w, http.StatusConflict, "check_in_progress")
			return
		}
		if errors.Is(err, context.DeadlineExceeded) {
			writeAdminError(w, http.StatusGatewayTimeout, "check_timeout")
			return
		}
		a.internal(w, "monitoring_check", err)
		return
	}
	a.monitoringOverview(w, r)
}

func (a *adminAPI) monitoringBuilder(w http.ResponseWriter, r *http.Request, id uint) {
	out, err := a.monitor.BuilderDetail(r.Context(), id)
	if err != nil {
		a.monitoringError(w, "monitoring_builder", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, out)
}

func (a *adminAPI) monitoringHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	for key := range q {
		switch key {
		case "builder_id", "country", "target_id", "period":
		default:
			writeAdminError(w, http.StatusBadRequest, "invalid_request")
			return
		}
	}
	query := netmon.HistoryQuery{Period: q.Get("period")}
	if query.Period == "" {
		query.Period = "24h"
	}
	if raw := q.Get("builder_id"); raw != "" {
		id, ok := parseAdminID(raw)
		if !ok {
			writeAdminError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		query.BuilderID = id
	}
	if raw := q.Get("target_id"); raw != "" {
		id, ok := parseAdminID(raw)
		if !ok {
			writeAdminError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		query.TargetID = id
	}
	if q.Has("country") {
		country := q.Get("country")
		if len(country) > adminMonitoringMaxCountry {
			writeAdminError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		query.Country = &country
	}
	out, err := a.monitor.History(r.Context(), query)
	if err != nil {
		a.monitoringError(w, "monitoring_history", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, out)
}

func (a *adminAPI) monitoringError(w http.ResponseWriter, op string, err error) {
	switch {
	case errors.Is(err, netmon.ErrNotFound):
		writeAdminError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, netmon.ErrInvalidQuery):
		writeAdminError(w, http.StatusBadRequest, "invalid_request")
	default:
		a.internal(w, op, err)
	}
}
