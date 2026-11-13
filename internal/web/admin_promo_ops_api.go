package web

import (
	"errors"
	"net/http"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
)

// Promo codes (/admin/api/promos*) and operational notifications
// (/admin/api/ops*). Both share the admin session, CSRF and the
// audit/idempotency contract of the other editors: every write carries a
// request_key; the same key with the same payload replays the recorded
// outcome, with another payload it is a conflict.
//
//	GET    /admin/api/promos             list
//	POST   /admin/api/promos             create (request_key)
//	PATCH  /admin/api/promos/{id}        limits, validity, note, enabled (request_key, version)
//	DELETE /admin/api/promos/{id}        delete an unused code (request_key, version)
//
//	GET    /admin/api/ops                settings (the bot token is never returned)
//	PUT    /admin/api/ops                save settings (request_key, version)
//	GET    /admin/api/ops/events         event feed: severity, kind, limit, offset
//	GET    /admin/api/ops/report         daily report preview: day=today|yesterday
//	POST   /admin/api/ops/test           send a test message now

// SetPromoService wires the promo code API under /admin/api/promos. Without
// it those (still session-protected) routes answer 503. Set before Start.
func (s *Server) SetPromoService(promoService *service.PromoService) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.promoService = promoService
}

// SetOpsService wires the operational notifications API under /admin/api/ops.
// Without it those (still session-protected) routes answer 503. Set before
// Start.
func (s *Server) SetOpsService(opsService *service.OpsService) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.opsService = opsService
}

// routePromos dispatches /admin/api/promos[/...]; segments[0] == "promos".
func (a *adminAPI) routePromos(w http.ResponseWriter, r *http.Request, segments []string) {
	if a.promoSvc == nil {
		writeAdminError(w, http.StatusServiceUnavailable, "service_unavailable")
		return
	}
	switch {
	case len(segments) == 1:
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			a.promoList(w, r)
		case http.MethodPost:
			a.promoCreate(w, r)
		default:
			w.Header().Set("Allow", "GET, HEAD, POST")
			writeAdminError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		}
	case len(segments) == 2:
		id, ok := parseAdminID(segments[1])
		if !ok {
			writeAdminError(w, http.StatusNotFound, "not_found")
			return
		}
		switch r.Method {
		case http.MethodPatch:
			a.promoUpdate(w, r, id)
		case http.MethodDelete:
			a.promoDelete(w, r, id)
		default:
			w.Header().Set("Allow", "PATCH, DELETE")
			writeAdminError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		}
	default:
		writeAdminError(w, http.StatusNotFound, "not_found")
	}
}

func (a *adminAPI) promoList(w http.ResponseWriter, r *http.Request) {
	views, err := a.promoSvc.List(r.Context())
	if err != nil {
		a.internal(w, "promos", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, struct {
		Promos []service.PromoView `json:"promos"`
	}{views})
}

// promoBody is the body of create and update. Unknown fields are rejected.
// ExpiresAt is RFC 3339 or empty/absent for "no limit".
type promoBody struct {
	RequestKey     string `json:"request_key"`
	Version        int    `json:"version"`
	Code           string `json:"code"`
	Percent        int    `json:"percent"`
	MaxActivations int    `json:"max_activations"`
	ValidHours     int    `json:"valid_hours"`
	ExpiresAt      string `json:"expires_at"`
	Enabled        bool   `json:"enabled"`
	Note           string `json:"note"`
}

// expiry parses the optional end of the code; ok is false for a bad value.
func (b promoBody) expiry() (*time.Time, bool) {
	if b.ExpiresAt == "" {
		return nil, true
	}
	parsed, err := time.Parse(time.RFC3339, b.ExpiresAt)
	if err != nil {
		return nil, false
	}
	parsed = parsed.UTC()
	return &parsed, true
}

func (a *adminAPI) promoCreate(w http.ResponseWriter, r *http.Request) {
	var body promoBody
	if !decodeAdminJSON(w, r, &body) {
		return
	}
	expires, ok := body.expiry()
	if !ok {
		a.writePromoError(w, "promo/create", &database.PromoFieldError{Field: "expires_at"})
		return
	}
	outcome, err := a.promoSvc.Create(r.Context(), a.actor, body.RequestKey, database.PromoInput{
		Code: body.Code, Percent: body.Percent, MaxActivations: body.MaxActivations, ValidHours: body.ValidHours,
		ExpiresAt: expires, Enabled: body.Enabled, Note: body.Note,
	})
	a.writePromoOutcome(w, "promo/create", http.StatusCreated, outcome, err)
}

func (a *adminAPI) promoUpdate(w http.ResponseWriter, r *http.Request, id uint) {
	var body promoBody
	if !decodeAdminJSON(w, r, &body) {
		return
	}
	expires, ok := body.expiry()
	if !ok {
		a.writePromoError(w, "promo/update", &database.PromoFieldError{Field: "expires_at"})
		return
	}
	outcome, err := a.promoSvc.Update(r.Context(), a.actor, body.RequestKey, database.PromoUpdate{
		ID: id, Version: body.Version, MaxActivations: body.MaxActivations, ValidHours: body.ValidHours,
		ExpiresAt: expires, Enabled: body.Enabled, Note: body.Note,
	})
	a.writePromoOutcome(w, "promo/update", http.StatusOK, outcome, err)
}

func (a *adminAPI) promoDelete(w http.ResponseWriter, r *http.Request, id uint) {
	var body struct {
		RequestKey string `json:"request_key"`
		Version    int    `json:"version"`
	}
	if !decodeAdminJSON(w, r, &body) {
		return
	}
	outcome, err := a.promoSvc.Delete(r.Context(), a.actor, body.RequestKey, id, body.Version)
	if err != nil {
		a.writePromoError(w, "promo/delete", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, struct {
		*service.PromoOutcome

		Deleted uint `json:"deleted"`
	}{outcome, id})
}

func (a *adminAPI) writePromoOutcome(w http.ResponseWriter, route string, status int, outcome *service.PromoOutcome, err error) {
	if err != nil {
		if outcome != nil && outcome.Audit.ID != 0 {
			// Committed and audited, but reloading failed: a retry replays.
			a.internal(w, route, err)
			return
		}
		a.writePromoError(w, route, err)
		return
	}
	writeAdminJSON(w, status, outcome)
}

func (a *adminAPI) writePromoError(w http.ResponseWriter, route string, err error) {
	var fieldErr *database.PromoFieldError
	switch {
	case errors.As(err, &fieldErr):
		writeAdminJSON(w, http.StatusBadRequest, struct {
			Error string `json:"error"`
			Field string `json:"field"`
		}{"invalid_promo", fieldErr.Field})
	case errors.Is(err, database.ErrAdminInvalidRequest):
		writeAdminError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, database.ErrPromoNotFound):
		writeAdminError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, database.ErrPromoCodeTaken):
		writeAdminError(w, http.StatusConflict, "promo_code_taken")
	case errors.Is(err, database.ErrPromoVersionConflict):
		writeAdminError(w, http.StatusConflict, "version_conflict")
	case errors.Is(err, database.ErrPromoInUse):
		writeAdminError(w, http.StatusConflict, "promo_in_use")
	case errors.Is(err, database.ErrAdminRequestKeyConflict):
		writeAdminError(w, http.StatusConflict, "request_key_conflict")
	default:
		a.internal(w, route, err)
	}
}

// routeOps dispatches /admin/api/ops[/...]; segments[0] == "ops".
func (a *adminAPI) routeOps(w http.ResponseWriter, r *http.Request, segments []string) {
	if a.opsSvc == nil {
		writeAdminError(w, http.StatusServiceUnavailable, "service_unavailable")
		return
	}
	switch {
	case len(segments) == 1:
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			a.opsSettings(w, r)
		case http.MethodPut:
			a.opsUpdate(w, r)
		default:
			w.Header().Set("Allow", "GET, HEAD, PUT")
			writeAdminError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		}
	case len(segments) == 2 && segments[1] == "events":
		a.get(w, r, a.opsEvents)
	case len(segments) == 2 && segments[1] == "report":
		a.get(w, r, a.opsReport)
	case len(segments) == 2 && segments[1] == "test":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeAdminError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		a.opsTest(w, r)
	default:
		writeAdminError(w, http.StatusNotFound, "not_found")
	}
}

func (a *adminAPI) opsSettings(w http.ResponseWriter, r *http.Request) {
	view, err := a.opsSvc.Settings(r.Context())
	if err != nil {
		a.internal(w, "ops", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, view)
}

// opsSettingsBody is the body of PUT /admin/api/ops. BotToken absent (null)
// keeps the stored token; an empty string switches back to the main bot.
type opsSettingsBody struct {
	RequestKey      string  `json:"request_key"`
	Version         int     `json:"version"`
	Enabled         bool    `json:"enabled"`
	ChatID          int64   `json:"chat_id"`
	BotToken        *string `json:"bot_token"`
	NotifyServers   bool    `json:"notify_servers"`
	NotifyCountries bool    `json:"notify_countries"`
	NotifySources   bool    `json:"notify_sources"`
	DailyReport     bool    `json:"daily_report"`
	DailyReportHour int     `json:"daily_report_hour"`
}

func (a *adminAPI) opsUpdate(w http.ResponseWriter, r *http.Request) {
	var body opsSettingsBody
	if !decodeAdminJSON(w, r, &body) {
		return
	}
	outcome, err := a.opsSvc.UpdateSettings(r.Context(), a.actor, body.RequestKey, database.OpsSettingsInput{
		Version: body.Version, Enabled: body.Enabled, ChatID: body.ChatID, BotToken: body.BotToken,
		NotifyServers: body.NotifyServers, NotifyCountries: body.NotifyCountries, NotifySources: body.NotifySources,
		DailyReport: body.DailyReport, DailyReportHour: body.DailyReportHour,
	})
	switch {
	case err == nil:
		writeAdminJSON(w, http.StatusOK, outcome)
	case outcome != nil && outcome.Audit.ID != 0:
		a.internal(w, "ops/update", err)
	case errors.Is(err, database.ErrOpsSettingsInvalid):
		writeAdminError(w, http.StatusBadRequest, "invalid_ops_settings")
	case errors.Is(err, database.ErrAdminInvalidRequest):
		writeAdminError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, database.ErrOpsVersionConflict):
		writeAdminError(w, http.StatusConflict, "version_conflict")
	case errors.Is(err, database.ErrAdminRequestKeyConflict):
		writeAdminError(w, http.StatusConflict, "request_key_conflict")
	default:
		a.internal(w, "ops/update", err)
	}
}

var opsSeverities = map[string]bool{
	"": true, database.OpsSeverityOK: true, database.OpsSeverityInfo: true,
	database.OpsSeverityWarning: true, database.OpsSeverityCritical: true,
}

func (a *adminAPI) opsEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	for key := range q {
		switch key {
		case "severity", "kind", "limit", "offset":
		default:
			writeAdminError(w, http.StatusBadRequest, "invalid_request")
			return
		}
	}
	limit, ok1 := parseAdminInt(q.Get("limit"), 0)
	offset, ok2 := parseAdminInt(q.Get("offset"), 0)
	kind := q.Get("kind")
	if !ok1 || !ok2 || limit < 0 || offset < 0 || !opsSeverities[q.Get("severity")] || len(kind) > 40 {
		writeAdminError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	page, err := a.opsSvc.Events(r.Context(), database.OpsEventFilter{Severity: q.Get("severity"), Kind: kind, Limit: limit, Offset: offset})
	if err != nil {
		a.internal(w, "ops/events", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, page)
}

func (a *adminAPI) opsReport(w http.ResponseWriter, r *http.Request) {
	offset := 0
	switch r.URL.Query().Get("day") {
	case "", "today":
	case "yesterday":
		offset = 1
	default:
		writeAdminError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	report, err := a.opsSvc.Report(r.Context(), offset)
	if err != nil {
		a.internal(w, "ops/report", err)
		return
	}
	writeAdminJSON(w, http.StatusOK, report)
}

func (a *adminAPI) opsTest(w http.ResponseWriter, r *http.Request) {
	var body struct{}
	if !decodeAdminJSON(w, r, &body) {
		return
	}
	err := a.opsSvc.SendTest(r.Context())
	switch {
	case err == nil:
		writeAdminJSON(w, http.StatusOK, struct {
			Sent bool `json:"sent"`
		}{true})
	case errors.Is(err, service.ErrOpsNotConfigured):
		writeAdminError(w, http.StatusConflict, "ops_not_configured")
	default:
		// The delivery failed (wrong chat, the bot is not started by the
		// recipient, a bad token): the operator has to fix the settings.
		writeAdminError(w, http.StatusBadGateway, "ops_send_failed")
	}
}
