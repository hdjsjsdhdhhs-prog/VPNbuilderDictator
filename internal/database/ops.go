package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Operational notifications (migration 053): the settings row, the event feed
// shown in Admin -> "События" and delivered to Telegram, the last known state
// per subject (alerts fire on transitions only) and the figures of the daily
// report. Nothing here holds a provider credential; the optional Telegram bot
// token of the notification channel is stored server-side and never returned.

// AdminActionOpsSettingsUpdated is the audited ops action.
const AdminActionOpsSettingsUpdated AdminAction = "ops_settings_updated"

// AdminTargetOps is the audit target type of the ops settings.
const AdminTargetOps = "ops_settings"

// Event severities (ops_events.severity).
const (
	OpsSeverityOK       = "ok"
	OpsSeverityInfo     = "info"
	OpsSeverityWarning  = "warning"
	OpsSeverityCritical = "critical"
)

// Event kinds (ops_events.kind).
const (
	OpsKindServerDown       = "server_down"
	OpsKindServerUp         = "server_up"
	OpsKindServerRemoved    = "server_removed"
	OpsKindCountryDown      = "country_down"
	OpsKindCountryDegraded  = "country_degraded"
	OpsKindCountryUp        = "country_up"
	OpsKindCountryRemoved   = "country_removed"
	OpsKindBuilderDown      = "builder_down"
	OpsKindBuilderDegraded  = "builder_degraded"
	OpsKindBuilderUp        = "builder_up"
	OpsKindBuilderDisabled  = "builder_disabled"
	OpsKindSourceFailing    = "source_failing"
	OpsKindSourceRecovered  = "source_recovered"
	OpsKindSourceExpiring   = "source_expiring"
	OpsKindSourceExpired    = "source_expired"
	OpsKindSourceDisabled   = "source_disabled"
	OpsKindDailyReport      = "daily_report"
	OpsKindTest             = "test"
	OpsKindMonitorStalled   = "monitor_stalled"
	OpsKindMonitorRecovered = "monitor_recovered"
)

// Delivery states (ops_events.notify_status).
const (
	OpsNotifyPending = "pending"
	OpsNotifySent    = "sent"
	OpsNotifyFailed  = "failed"
	OpsNotifySkipped = "skipped"
)

// OpsMaxNotifyAttempts bounds the delivery retries of one event.
const OpsMaxNotifyAttempts = 5

var (
	ErrOpsSettingsInvalid  = errors.New("ops settings are invalid")
	ErrOpsVersionConflict  = errors.New("ops settings were changed concurrently")
	opsBotTokenPattern     = regexp.MustCompile(`^[0-9]{5,15}:[A-Za-z0-9_-]{30,64}$`)
	opsReportDayPattern    = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	opsEventSeverityValues = map[string]bool{OpsSeverityOK: true, OpsSeverityInfo: true, OpsSeverityWarning: true, OpsSeverityCritical: true}
)

// OpsSettings is the single settings row (id = 1).
type OpsSettings struct {
	ID              uint      `gorm:"primaryKey;column:id"     json:"-"`
	Enabled         bool      `gorm:"column:enabled"           json:"enabled"`
	ChatID          int64     `gorm:"column:chat_id"           json:"chat_id"`
	BotToken        string    `gorm:"column:bot_token"         json:"-"`
	NotifyServers   bool      `gorm:"column:notify_servers"    json:"notify_servers"`
	NotifyCountries bool      `gorm:"column:notify_countries"  json:"notify_countries"`
	NotifySources   bool      `gorm:"column:notify_sources"    json:"notify_sources"`
	DailyReport     bool      `gorm:"column:daily_report"      json:"daily_report"`
	DailyReportHour int       `gorm:"column:daily_report_hour" json:"daily_report_hour"`
	LastReportDay   string    `gorm:"column:last_report_day"   json:"last_report_day"`
	BaselineAt      time.Time `gorm:"column:baseline_at"       json:"baseline_at"`
	Version         int       `gorm:"column:version"           json:"version"`
	UpdatedAt       time.Time `gorm:"column:updated_at"        json:"updated_at"`
}

func (OpsSettings) TableName() string { return "ops_settings" }

// OpsEvent is one row of the event feed.
type OpsEvent struct {
	ID             uint       `gorm:"primaryKey;column:id"   json:"id"`
	CreatedAt      time.Time  `gorm:"column:created_at"      json:"created_at"`
	Kind           string     `gorm:"column:kind"            json:"kind"`
	Severity       string     `gorm:"column:severity"        json:"severity"`
	Title          string     `gorm:"column:title"           json:"title"`
	Message        string     `gorm:"column:message"         json:"message"`
	BuilderID      *uint      `gorm:"column:builder_id"      json:"builder_id"`
	SourceID       *uint      `gorm:"column:source_id"       json:"source_id"`
	TargetID       *uint      `gorm:"column:target_id"       json:"target_id"`
	CountryCode    string     `gorm:"column:country_code"    json:"country_code"`
	Details        string     `gorm:"column:details"         json:"-"`
	DedupKey       *string    `gorm:"column:dedup_key"       json:"-"`
	NotifyStatus   string     `gorm:"column:notify_status"   json:"notify_status"`
	NotifyAttempts int        `gorm:"column:notify_attempts" json:"-"`
	NotifiedAt     *time.Time `gorm:"column:notified_at"     json:"notified_at"`
	NotifyError    string     `gorm:"column:notify_error"    json:"notify_error"`
}

func (OpsEvent) TableName() string { return "ops_events" }

// OpsState is the last known state of a subject.
type OpsState struct {
	Key   string    `gorm:"primaryKey;column:key"`
	State string    `gorm:"column:state"`
	Since time.Time `gorm:"column:since"`
}

func (OpsState) TableName() string { return "ops_states" }

// GetOpsSettings returns the settings row.
func (s *Service) GetOpsSettings(ctx context.Context) (*OpsSettings, error) {
	var settings OpsSettings
	err := s.db.WithContext(ctx).First(&settings, 1).Error
	if err != nil {
		return nil, fmt.Errorf("load ops settings: %w", err)
	}
	return &settings, nil
}

// OpsSettingsInput is the editable part of the settings. BotToken nil keeps
// the stored token; an empty string clears it (the main bot is used).
type OpsSettingsInput struct {
	Version         int
	Enabled         bool
	ChatID          int64
	BotToken        *string
	NotifyServers   bool
	NotifyCountries bool
	NotifySources   bool
	DailyReport     bool
	DailyReportHour int
}

// opsSettingsAudit is the credential-free audit projection.
type opsSettingsAudit struct {
	Enabled         bool  `json:"enabled"`
	ChatID          int64 `json:"chat_id"`
	OwnBot          bool  `json:"own_bot"`
	NotifyServers   bool  `json:"notify_servers"`
	NotifyCountries bool  `json:"notify_countries"`
	NotifySources   bool  `json:"notify_sources"`
	DailyReport     bool  `json:"daily_report"`
	DailyReportHour int   `json:"daily_report_hour"`
	Version         int   `json:"version"`
}

func opsAudit(s *OpsSettings) opsSettingsAudit {
	return opsSettingsAudit{
		Enabled: s.Enabled, ChatID: s.ChatID, OwnBot: s.BotToken != "", NotifyServers: s.NotifyServers,
		NotifyCountries: s.NotifyCountries, NotifySources: s.NotifySources, DailyReport: s.DailyReport,
		DailyReportHour: s.DailyReportHour, Version: s.Version,
	}
}

// UpdateOpsSettings saves the settings with optimistic locking. The bot token
// never reaches the audit log: the request hash carries only its digest.
func (s *Service) UpdateOpsSettings(ctx context.Context, meta AdminConfigMeta, in OpsSettingsInput) (*AdminConfigResult, error) {
	if in.Version <= 0 || in.DailyReportHour < 0 || in.DailyReportHour > 23 {
		return nil, ErrOpsSettingsInvalid
	}
	tokenDigest := "keep"
	if in.BotToken != nil {
		token := strings.TrimSpace(*in.BotToken)
		if token != "" && !opsBotTokenPattern.MatchString(token) {
			return nil, ErrOpsSettingsInvalid
		}
		in.BotToken = &token
		sum := sha256.Sum256([]byte(token))
		tokenDigest = hex.EncodeToString(sum[:])
	}
	payload := struct {
		Version         int    `json:"version"`
		Enabled         bool   `json:"enabled"`
		ChatID          int64  `json:"chat_id"`
		Token           string `json:"token"`
		NotifyServers   bool   `json:"notify_servers"`
		NotifyCountries bool   `json:"notify_countries"`
		NotifySources   bool   `json:"notify_sources"`
		DailyReport     bool   `json:"daily_report"`
		DailyReportHour int    `json:"daily_report_hour"`
	}{in.Version, in.Enabled, in.ChatID, tokenDigest, in.NotifyServers, in.NotifyCountries, in.NotifySources, in.DailyReport, in.DailyReportHour}
	return s.runAdminConfigMutation(ctx, meta, AdminActionOpsSettingsUpdated, AdminTargetOps, 1, payload,
		func(tx *gorm.DB, now time.Time) (configChange, error) {
			var current OpsSettings
			err := tx.First(&current, 1).Error
			if err != nil {
				return configChange{}, fmt.Errorf("load ops settings: %w", err)
			}
			cols := map[string]any{
				"enabled": in.Enabled, "chat_id": in.ChatID, "notify_servers": in.NotifyServers,
				"notify_countries": in.NotifyCountries, "notify_sources": in.NotifySources,
				"daily_report": in.DailyReport, "daily_report_hour": in.DailyReportHour,
				"version": in.Version + 1, "updated_at": now,
			}
			if in.BotToken != nil {
				cols["bot_token"] = *in.BotToken
			}
			update := tx.Model(&OpsSettings{}).Where("id = 1 AND version = ?", in.Version).Updates(cols)
			if update.Error != nil {
				return configChange{}, fmt.Errorf("update ops settings: %w", update.Error)
			}
			if update.RowsAffected == 0 {
				return configChange{}, ErrOpsVersionConflict
			}
			var saved OpsSettings
			err = tx.First(&saved, 1).Error
			if err != nil {
				return configChange{}, fmt.Errorf("reload ops settings: %w", err)
			}
			return configChange{targetID: 1, oldValue: opsAudit(&current), newValue: opsAudit(&saved)}, nil
		})
}

// ClaimOpsReportDay records that the daily report of day (YYYY-MM-DD, Moscow)
// is being sent. false: another run already claimed this or a later day.
func (s *Service) ClaimOpsReportDay(ctx context.Context, day string) (bool, error) {
	if !opsReportDayPattern.MatchString(day) {
		return false, ErrOpsSettingsInvalid
	}
	result := s.db.WithContext(ctx).Model(&OpsSettings{}).Where("id = 1 AND last_report_day < ?", day).
		UpdateColumn("last_report_day", day)
	if result.Error != nil {
		return false, fmt.Errorf("claim ops report day: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// RecordOpsEvent appends an event. With a DedupKey the insert is idempotent:
// false means the event already exists and nothing was written.
func (s *Service) RecordOpsEvent(ctx context.Context, ev *OpsEvent) (bool, error) {
	if ev == nil || ev.Kind == "" || ev.Title == "" || !opsEventSeverityValues[ev.Severity] {
		return false, fmt.Errorf("record ops event: invalid event")
	}
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = time.Now().UTC()
	}
	ev.CreatedAt = ev.CreatedAt.UTC()
	if ev.Details == "" {
		ev.Details = "{}"
	}
	if ev.NotifyStatus == "" {
		ev.NotifyStatus = OpsNotifyPending
	}
	result := s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(ev)
	if result.Error != nil {
		return false, fmt.Errorf("record ops event: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// ExistingOpsEventKeys returns which of the dedup keys are already recorded.
func (s *Service) ExistingOpsEventKeys(ctx context.Context, keys []string) (map[string]bool, error) {
	found := make(map[string]bool, len(keys))
	const chunk = 400
	for start := 0; start < len(keys); start += chunk {
		end := min(start+chunk, len(keys))
		var rows []string
		err := s.db.WithContext(ctx).Model(&OpsEvent{}).Where("dedup_key IN ?", keys[start:end]).Pluck("dedup_key", &rows).Error
		if err != nil {
			return nil, fmt.Errorf("load ops event keys: %w", err)
		}
		for _, key := range rows {
			found[key] = true
		}
	}
	return found, nil
}

// PendingOpsEvents returns events waiting for delivery, oldest first.
func (s *Service) PendingOpsEvents(ctx context.Context, limit int) ([]OpsEvent, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var events []OpsEvent
	err := s.db.WithContext(ctx).Where("notify_status = ?", OpsNotifyPending).Order("id ASC").Limit(limit).Find(&events).Error
	if err != nil {
		return nil, fmt.Errorf("load pending ops events: %w", err)
	}
	return events, nil
}

// FinishOpsEvents records the delivery outcome of a batch. A failed delivery
// stays pending until OpsMaxNotifyAttempts, then becomes failed.
func (s *Service) FinishOpsEvents(ctx context.Context, ids []uint, sendErr string, now time.Time) error {
	if len(ids) == 0 {
		return nil
	}
	now = now.UTC()
	db := s.db.WithContext(ctx).Model(&OpsEvent{}).Where("id IN ? AND notify_status = ?", ids, OpsNotifyPending)
	if sendErr == "" {
		err := db.Updates(map[string]any{"notify_status": OpsNotifySent, "notified_at": now, "notify_error": ""}).Error
		if err != nil {
			return fmt.Errorf("mark ops events sent: %w", err)
		}
		return nil
	}
	if len(sendErr) > 300 {
		sendErr = sendErr[:300]
	}
	err := db.Updates(map[string]any{
		"notify_attempts": gorm.Expr("notify_attempts + 1"), "notify_error": sendErr,
		"notify_status": gorm.Expr("CASE WHEN notify_attempts + 1 >= ? THEN ? ELSE ? END", OpsMaxNotifyAttempts, OpsNotifyFailed, OpsNotifyPending),
	}).Error
	if err != nil {
		return fmt.Errorf("mark ops events failed: %w", err)
	}
	return nil
}

// SkipPendingOpsEvents drops the delivery of everything still pending (the
// notifications were switched off); the events stay in the feed.
func (s *Service) SkipPendingOpsEvents(ctx context.Context) error {
	err := s.db.WithContext(ctx).Model(&OpsEvent{}).Where("notify_status = ?", OpsNotifyPending).
		Update("notify_status", OpsNotifySkipped).Error
	if err != nil {
		return fmt.Errorf("skip pending ops events: %w", err)
	}
	return nil
}

// OpsEventFilter narrows ListOpsEvents; zero values match all.
type OpsEventFilter struct {
	Severity string
	Kind     string
	Limit    int
	Offset   int
}

// ListOpsEvents pages the feed, newest first.
func (s *Service) ListOpsEvents(ctx context.Context, f OpsEventFilter) ([]OpsEvent, int64, error) {
	limit, offset := adminPage(f.Limit, f.Offset)
	base := s.db.WithContext(ctx).Model(&OpsEvent{})
	if f.Severity != "" {
		base = base.Where("severity = ?", f.Severity)
	}
	if f.Kind != "" {
		base = base.Where("kind = ?", f.Kind)
	}
	var total int64
	err := base.Count(&total).Error
	if err != nil {
		return nil, 0, fmt.Errorf("count ops events: %w", err)
	}
	events := []OpsEvent{}
	err = base.Order("created_at DESC, id DESC").Limit(limit).Offset(offset).Find(&events).Error
	if err != nil {
		return nil, 0, fmt.Errorf("list ops events: %w", err)
	}
	return events, total, nil
}

// PruneOpsEvents deletes feed rows older than cutoff.
func (s *Service) PruneOpsEvents(ctx context.Context, cutoff time.Time) (int64, error) {
	result := s.db.WithContext(ctx).Where("created_at < ?", cutoff.UTC()).Delete(&OpsEvent{})
	if result.Error != nil {
		return 0, fmt.Errorf("prune ops events: %w", result.Error)
	}
	return result.RowsAffected, nil
}

// SwapOpsState stores the current state of a subject and returns the previous
// one ("" when the subject is new). changed is false when nothing changed.
func (s *Service) SwapOpsState(ctx context.Context, key, state string, now time.Time) (previous string, changed bool, err error) {
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current OpsState
		switch err := tx.First(&current, "key = ?", key).Error; {
		case errors.Is(err, gorm.ErrRecordNotFound):
			changed = true
			return tx.Create(&OpsState{Key: key, State: state, Since: now.UTC()}).Error
		case err != nil:
			return err
		}
		previous = current.State
		if current.State == state {
			return nil
		}
		changed = true
		return tx.Model(&OpsState{}).Where("key = ?", key).Updates(map[string]any{"state": state, "since": now.UTC()}).Error
	})
	if err != nil {
		return "", false, fmt.Errorf("swap ops state %q: %w", key, err)
	}
	return previous, changed, nil
}

// OpsOutage is a monitor outage with the names an alert needs.
type OpsOutage struct {
	MonitorOutage

	BuilderName string
	// BuilderNames lists every builder that serves the server of a target
	// outage (a server is checked once however many builders hand it out);
	// the last known builder when none serves it any more.
	BuilderNames []string
	NodeName     string
	Host        string
	Port        int
	Protocol    string
}

// ListOpsOutages returns outages that started or ended at or after since,
// oldest first, enriched with builder and server names (credential-free).
func (s *Service) ListOpsOutages(ctx context.Context, since time.Time, limit int) ([]OpsOutage, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	since = since.UTC()
	var outages []MonitorOutage
	err := s.db.WithContext(ctx).Where("started_at >= ? OR ended_at >= ?", since, since).
		Order("id ASC").Limit(limit).Find(&outages).Error
	if err != nil {
		return nil, fmt.Errorf("list ops outages: %w", err)
	}
	if len(outages) == 0 {
		return nil, nil
	}
	var targetIDs, builderIDs []uint
	for _, o := range outages {
		if o.TargetID != nil {
			targetIDs = append(targetIDs, *o.TargetID)
		}
		if o.BuilderID != nil {
			builderIDs = append(builderIDs, *o.BuilderID)
		}
	}
	targets := map[uint]MonitorTarget{}
	nodeNames := map[uint]string{}
	targetBuilders := map[uint]string{}
	targetCountries := map[uint]string{}
	servedBy := map[uint][]string{}
	if len(targetIDs) > 0 {
		var rows []MonitorTarget
		err := s.db.WithContext(ctx).Where("id IN ?", targetIDs).Find(&rows).Error
		if err != nil {
			return nil, fmt.Errorf("load outage targets: %w", err)
		}
		for _, t := range rows {
			targets[t.ID] = t
		}
		var bindings []MonitorBinding
		err = s.db.WithContext(ctx).Where("target_id IN ?", targetIDs).Order("active ASC, last_seen_at ASC, id ASC").Find(&bindings).Error
		if err != nil {
			return nil, fmt.Errorf("load outage bindings: %w", err)
		}
		// Later rows win: active, most recently seen bindings name the server.
		for _, b := range bindings {
			nodeNames[b.TargetID] = b.NodeName
			targetBuilders[b.TargetID] = b.BuilderName
			targetCountries[b.TargetID] = b.CountryCode
			if b.Active && b.BuilderName != "" && !slices.Contains(servedBy[b.TargetID], b.BuilderName) {
				servedBy[b.TargetID] = append(servedBy[b.TargetID], b.BuilderName)
			}
		}
	}
	builders := map[uint]string{}
	if len(builderIDs) > 0 {
		var rows []SubscriptionBuilder
		err := s.db.WithContext(ctx).Select("id", "name").Where("id IN ?", builderIDs).Find(&rows).Error
		if err != nil {
			return nil, fmt.Errorf("load outage builders: %w", err)
		}
		for _, b := range rows {
			builders[b.ID] = b.Name
		}
	}
	out := make([]OpsOutage, 0, len(outages))
	for _, o := range outages {
		row := OpsOutage{MonitorOutage: o}
		if o.BuilderID != nil {
			row.BuilderName = builders[*o.BuilderID]
		}
		if o.TargetID != nil {
			t := targets[*o.TargetID]
			row.Host, row.Port, row.Protocol = t.Host, t.Port, t.Protocol
			row.NodeName = nodeNames[*o.TargetID]
			if row.BuilderName == "" {
				row.BuilderName = targetBuilders[*o.TargetID]
			}
			row.BuilderNames = servedBy[*o.TargetID]
			if len(row.BuilderNames) == 0 && row.BuilderName != "" {
				row.BuilderNames = []string{row.BuilderName}
			}
			// A target outage has no country of its own: the server's country
			// is the one its builders list it under.
			if row.CountryCode == "" {
				row.CountryCode = targetCountries[*o.TargetID]
			}
		}
		out = append(out, row)
	}
	return out, nil
}

// OpsMoney is a sum in one currency (minor units; whole Stars for XTR).
type OpsMoney struct {
	Currency    string `json:"currency"`
	AmountCents int64  `json:"amount_cents"`
	Orders      int64  `json:"orders"`
}

// OpsDailyStats is the figures of the daily report for [From, To).
type OpsDailyStats struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`

	UsersTotal       int64      `json:"users_total"`
	UsersNew         int64      `json:"users_new"`
	ActiveSubs       int64      `json:"active_subscriptions"`
	PaidActiveSubs   int64      `json:"paid_active_subscriptions"`
	TrialsStarted    int64      `json:"trials_started"`
	TrialsBound      int64      `json:"trials_bound"`
	Purchases        int64      `json:"purchases"`
	Renewals         int64      `json:"renewals"`
	FreeActivations  int64      `json:"free_activations"`
	Expired          int64      `json:"expired"`
	Refunds          int64      `json:"refunds"`
	PromoActivations int64      `json:"promo_activations"`
	PromoRedemptions int64      `json:"promo_redemptions"`
	Connected        int64      `json:"connected"`
	IncidentsCountry int64      `json:"incidents_country"`
	IncidentsServer  int64      `json:"incidents_server"`
	OpenIncidents    int64      `json:"open_incidents"`
	ExpiringIn3Days  int64      `json:"expiring_in_3_days"`
	SourcesTotal     int64      `json:"sources_total"`
	SourcesUnusable  int64      `json:"sources_unusable"`
	BuildersEnabled  int64      `json:"builders_enabled"`
	WarmupSent       int64      `json:"warmup_sent"`
	PendingOrders    int64      `json:"pending_orders"`
	PeriodRevenue    []OpsMoney `json:"period_revenue"`
	TotalRevenue     []OpsMoney `json:"total_revenue"`
}

// OpsDailyStats collects the report figures for [from, to). now is the moment
// the snapshot counters (active subscriptions, open incidents) refer to.
func (s *Service) OpsDailyStats(ctx context.Context, from, to, now time.Time) (*OpsDailyStats, error) {
	from, to, now = from.UTC(), to.UTC(), now.UTC()
	st := &OpsDailyStats{From: from, To: to, PeriodRevenue: []OpsMoney{}, TotalRevenue: []OpsMoney{}}
	db := s.db.WithContext(ctx)
	count := func(dst *int64, model any, query string, args ...any) error {
		return db.Model(model).Where(query, args...).Count(dst).Error
	}
	journal := func(dst *int64, types ...string) error {
		return db.Model(&JournalEvent{}).Where("event_type IN ? AND outcome = ? AND created_at >= ? AND created_at < ?", types, "success", from, to).Count(dst).Error
	}
	active := string(SubscriptionStatusActive)
	steps := []func() error{
		func() error { return count(&st.UsersTotal, &Subscription{}, "telegram_id > 0") },
		func() error { return journal(&st.UsersNew, "user_registered", "trial_bound") },
		func() error { return count(&st.ActiveSubs, &Subscription{}, "telegram_id > 0 AND status = ?", active) },
		func() error {
			return count(&st.PaidActiveSubs, &Subscription{},
				"telegram_id > 0 AND status = ? AND (product_id IS NOT NULL OR price_paid_cents > 0) AND (expires_at IS NULL OR expires_at > ?)", active, now)
		},
		func() error { return journal(&st.TrialsStarted, "trial_started") },
		func() error { return journal(&st.TrialsBound, "trial_bound") },
		func() error { return journal(&st.Purchases, "paid_activated") },
		func() error { return journal(&st.Renewals, "subscription_renewed") },
		func() error { return journal(&st.Expired, "subscription_expired") },
		func() error { return journal(&st.Refunds, "payment_refunded") },
		func() error {
			return count(&st.FreeActivations, &Order{}, "status = ? AND payment_provider = ? AND paid_at >= ? AND paid_at < ?", OrderStatusPaid, FreeProvider, from, to)
		},
		func() error {
			return count(&st.PromoActivations, &UserDiscount{}, "activated_at >= ? AND activated_at < ?", from, to)
		},
		func() error {
			return count(&st.PromoRedemptions, &UserDiscount{}, "redeemed_at >= ? AND redeemed_at < ?", from, to)
		},
		func() error {
			return count(&st.Connected, &Subscription{}, "telegram_id > 0 AND last_request >= ? AND last_request < ?", from, to)
		},
		func() error {
			return count(&st.IncidentsCountry, &MonitorOutage{}, "scope = ? AND started_at >= ? AND started_at < ?", MonitorScopeCountry, from, to)
		},
		func() error {
			return count(&st.IncidentsServer, &MonitorOutage{}, "scope = ? AND started_at >= ? AND started_at < ?", MonitorScopeTarget, from, to)
		},
		func() error { return count(&st.OpenIncidents, &MonitorOutage{}, "ended_at IS NULL") },
		func() error {
			return count(&st.ExpiringIn3Days, &Subscription{},
				"telegram_id > 0 AND status = ? AND (product_id IS NOT NULL OR price_paid_cents > 0) AND expires_at > ? AND expires_at <= ?",
				active, now, now.Add(72*time.Hour))
		},
		func() error { return count(&st.BuildersEnabled, &SubscriptionBuilder{}, "enabled = ?", true) },
		func() error {
			return count(&st.WarmupSent, &WarmupDelivery{}, "status = ? AND sent_at >= ? AND sent_at < ?", "sent", from, to)
		},
		func() error {
			return count(&st.PendingOrders, &Order{}, "status = ? AND created_at >= ? AND created_at < ?", OrderStatusPending, from, to)
		},
		func() error {
			return db.Model(&Order{}).Select("currency, COALESCE(SUM(amount_cents), 0) AS amount_cents, COUNT(*) AS orders").
				Where("status = ? AND amount_cents > 0 AND paid_at >= ? AND paid_at < ?", OrderStatusPaid, from, to).
				Group("currency").Order("currency").Scan(&st.PeriodRevenue).Error
		},
		func() error {
			return db.Model(&Order{}).Select("currency, COALESCE(SUM(amount_cents), 0) AS amount_cents, COUNT(*) AS orders").
				Where("status = ? AND amount_cents > 0", OrderStatusPaid).
				Group("currency").Order("currency").Scan(&st.TotalRevenue).Error
		},
	}
	for _, step := range steps {
		err := step()
		if err != nil {
			return nil, fmt.Errorf("collect ops stats: %w", err)
		}
	}
	// Sources: usability is decided in Go (RequestConfiguration), like /sub.
	var sources []ProviderSource
	err := db.Find(&sources).Error
	if err != nil {
		return nil, fmt.Errorf("collect ops stats: sources: %w", err)
	}
	st.SourcesTotal = int64(len(sources))
	for i := range sources {
		_, _, err = sources[i].RequestConfiguration()
		if err != nil {
			st.SourcesUnusable++
		}
	}
	if st.PeriodRevenue == nil {
		st.PeriodRevenue = []OpsMoney{}
	}
	if st.TotalRevenue == nil {
		st.TotalRevenue = []OpsMoney{}
	}
	return st, nil
}

// ListOpsSources returns every provider source for the expiry watch. The rows
// carry credentials and must never be serialized.
func (s *Service) ListOpsSources(ctx context.Context) ([]ProviderSource, error) {
	var sources []ProviderSource
	err := s.db.WithContext(ctx).Order("id ASC").Find(&sources).Error
	if err != nil {
		return nil, fmt.Errorf("list ops sources: %w", err)
	}
	return sources, nil
}
