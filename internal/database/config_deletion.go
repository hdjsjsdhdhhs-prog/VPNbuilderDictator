package database

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// Deletion of provider sources and subscription builders (Admin -> "Источники"
// / "Построители").
//
// Both could only be switched off before, so every test or retired entry stayed
// in the lists forever. A row may now be physically deleted, but only while
// nothing depends on it:
//
//   - a source is blocked by any builder that links it or has a rule on it,
//     and by any subscription sold directly on it (provider_source_id);
//   - a builder is blocked by any plan whose default it is (the system trial
//     plan included) and by any per-subscription override.
//
// The foreign keys would SET NULL the plan/subscription references and silently
// leave customers without content (/sub answers 503 without a builder), so the
// dependency check is explicit and the request is rejected instead
// (ErrProviderSourceInUse / ErrBuilderInUse). Switching off stays the way to
// retire something that is still referenced.
//
// Deletions are audited through runAdminConfigMutation and idempotent by
// (actor, request_key). Monitoring history (monitor_bindings, monitor_outages)
// has no foreign keys and outlives the deleted rows by design.

// Audited deletion actions.
const (
	AdminActionSourceDeleted  AdminAction = "source_deleted"
	AdminActionBuilderDeleted AdminAction = "builder_deleted"
)

// Deletion rejections. Like the other configuration rejections they are
// returned to the caller and NOT audited: nothing changed.
var (
	ErrProviderSourceInUse = errors.New("provider source is used by builders or subscriptions")
	ErrBuilderInUse        = errors.New("subscription builder is used by plans or subscriptions")
)

// DependentRef names one row that depends on the subject of a deletion.
type DependentRef struct {
	ID   uint   `json:"id"`
	Name string `json:"name"`
}

// SourceDependents is what still relies on a provider source.
type SourceDependents struct {
	// Builders link the source or have a rule on it.
	Builders []DependentRef `json:"builders"`
	// Subscriptions were sold directly on the source (provider_source_id).
	Subscriptions int64 `json:"subscriptions"`
}

// InUse reports whether the source may not be deleted.
func (d SourceDependents) InUse() bool { return len(d.Builders) > 0 || d.Subscriptions > 0 }

// BuilderDependents is what still relies on a subscription builder.
type BuilderDependents struct {
	// Plans use the builder as their default (the trial plan included).
	Plans []DependentRef `json:"plans"`
	// Subscriptions override their plan builder with this one.
	Subscriptions int64 `json:"subscriptions"`
}

// InUse reports whether the builder may not be deleted.
func (d BuilderDependents) InUse() bool { return len(d.Plans) > 0 || d.Subscriptions > 0 }

// sourceDependents loads the dependents of every source (onlyID = 0) or of one.
func sourceDependents(tx *gorm.DB, onlyID uint) (map[uint]SourceDependents, error) {
	out := map[uint]SourceDependents{}
	type link struct {
		SourceID  uint
		BuilderID uint
		Name      string
	}
	// A builder depends on a source through its source list and through its
	// rules; a rule may name a source that is no longer linked.
	const linksSQL = `
SELECT refs.source_id AS source_id, b.id AS builder_id, b.name AS name
FROM (
    SELECT source_id, builder_id FROM subscription_builder_sources
    UNION
    SELECT source_id, builder_id FROM subscription_builder_items
) AS refs
JOIN subscription_builders b ON b.id = refs.builder_id
WHERE (? = 0 OR refs.source_id = ?)
ORDER BY b.name ASC, b.id ASC`
	var links []link
	err := tx.Raw(linksSQL, onlyID, onlyID).Scan(&links).Error
	if err != nil {
		return nil, fmt.Errorf("load source builders: %w", err)
	}
	for _, l := range links {
		d := out[l.SourceID]
		d.Builders = append(d.Builders, DependentRef{ID: l.BuilderID, Name: l.Name})
		out[l.SourceID] = d
	}
	var counts []struct {
		SourceID uint
		N        int64
	}
	query := tx.Model(&Subscription{}).Select("provider_source_id AS source_id, COUNT(*) AS n").
		Where("provider_source_id IS NOT NULL")
	if onlyID != 0 {
		query = query.Where("provider_source_id = ?", onlyID)
	}
	err = query.Group("provider_source_id").Scan(&counts).Error
	if err != nil {
		return nil, fmt.Errorf("count source subscriptions: %w", err)
	}
	for _, c := range counts {
		d := out[c.SourceID]
		d.Subscriptions = c.N
		out[c.SourceID] = d
	}
	return out, nil
}

// builderDependents loads the dependents of every builder (onlyID = 0) or of one.
func builderDependents(tx *gorm.DB, onlyID uint) (map[uint]BuilderDependents, error) {
	out := map[uint]BuilderDependents{}
	var plans []Plan
	query := tx.Select("id", "name", "subscription_builder_id").Where("subscription_builder_id IS NOT NULL")
	if onlyID != 0 {
		query = query.Where("subscription_builder_id = ?", onlyID)
	}
	err := query.Order("name ASC, id ASC").Find(&plans).Error
	if err != nil {
		return nil, fmt.Errorf("load builder plans: %w", err)
	}
	for _, p := range plans {
		d := out[*p.SubscriptionBuilderID]
		d.Plans = append(d.Plans, DependentRef{ID: p.ID, Name: p.Name})
		out[*p.SubscriptionBuilderID] = d
	}
	var counts []struct {
		BuilderID uint
		N         int64
	}
	countQuery := tx.Model(&Subscription{}).Select("subscription_builder_id AS builder_id, COUNT(*) AS n").
		Where("subscription_builder_id IS NOT NULL")
	if onlyID != 0 {
		countQuery = countQuery.Where("subscription_builder_id = ?", onlyID)
	}
	err = countQuery.Group("subscription_builder_id").Scan(&counts).Error
	if err != nil {
		return nil, fmt.Errorf("count builder subscriptions: %w", err)
	}
	for _, c := range counts {
		d := out[c.BuilderID]
		d.Subscriptions = c.N
		out[c.BuilderID] = d
	}
	return out, nil
}

// normalized returns the dependents with a non-nil list ([] on the wire).
func (d SourceDependents) normalized() SourceDependents {
	if d.Builders == nil {
		d.Builders = []DependentRef{}
	}
	return d
}

func (d BuilderDependents) normalized() BuilderDependents {
	if d.Plans == nil {
		d.Plans = []DependentRef{}
	}
	return d
}

// SourceDependentsAll returns the dependents of every provider source that has
// any; a source missing from the map has none.
func (s *Service) SourceDependentsAll(ctx context.Context) (map[uint]SourceDependents, error) {
	var out map[uint]SourceDependents
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var err error
		out, err = sourceDependents(tx, 0)
		return err
	})
	if err != nil {
		return nil, err
	}
	for id, d := range out {
		out[id] = d.normalized()
	}
	return out, nil
}

// SourceDependentsFor returns the dependents of one provider source.
func (s *Service) SourceDependentsFor(ctx context.Context, sourceID uint) (SourceDependents, error) {
	var out SourceDependents
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		all, err := sourceDependents(tx, sourceID)
		if err != nil {
			return err
		}
		out = all[sourceID]
		return nil
	})
	if err != nil {
		return SourceDependents{}, err
	}
	return out.normalized(), nil
}

// BuilderDependentsAll returns the dependents of every builder that has any.
func (s *Service) BuilderDependentsAll(ctx context.Context) (map[uint]BuilderDependents, error) {
	var out map[uint]BuilderDependents
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var err error
		out, err = builderDependents(tx, 0)
		return err
	})
	if err != nil {
		return nil, err
	}
	for id, d := range out {
		out[id] = d.normalized()
	}
	return out, nil
}

// BuilderDependentsFor returns the dependents of one builder.
func (s *Service) BuilderDependentsFor(ctx context.Context, builderID uint) (BuilderDependents, error) {
	var out BuilderDependents
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		all, err := builderDependents(tx, builderID)
		if err != nil {
			return err
		}
		out = all[builderID]
		return nil
	})
	if err != nil {
		return BuilderDependents{}, err
	}
	return out.normalized(), nil
}

// sourceAuditView is the credential-free projection stored in the audit row:
// the upstream URL, HWID, User-Agent and headers are never recorded.
type sourceAuditView struct {
	ID          uint       `json:"id"`
	Name        string     `json:"name"`
	Type        string     `json:"type"`
	Description string     `json:"description"`
	Enabled     bool       `json:"enabled"`
	ExpiresAt   *time.Time `json:"expires_at"`
}

// DeleteProviderSource physically deletes a provider source that nothing
// depends on, together with its catalogue (provider_source_entries).
// ErrProviderSourceNotFound for a missing row, ErrProviderSourceInUse while a
// builder or a subscription still references it.
func (s *Service) DeleteProviderSource(ctx context.Context, meta AdminConfigMeta, id uint) (*AdminConfigResult, error) {
	if id == 0 {
		return nil, fmt.Errorf("%w: id", ErrAdminInvalidRequest)
	}
	payload := struct {
		ID uint `json:"id"`
	}{id}
	return s.runAdminConfigMutation(ctx, meta, AdminActionSourceDeleted, AdminTargetSource, id, payload,
		func(tx *gorm.DB, _ time.Time) (configChange, error) {
			// Take SQLite's write lock on the row before the dependency check,
			// so a concurrent builder save or subscription creation cannot add
			// a reference between the check and the delete.
			claim := tx.Model(&ProviderSource{}).Where("id = ?", id).UpdateColumn("id", gorm.Expr("id"))
			if claim.Error != nil {
				return configChange{}, fmt.Errorf("lock provider source: %w", claim.Error)
			}
			if claim.RowsAffected == 0 {
				return configChange{}, ErrProviderSourceNotFound
			}
			var src ProviderSource
			err := tx.First(&src, id).Error
			if err != nil {
				return configChange{}, fmt.Errorf("load provider source: %w", err)
			}
			deps, err := sourceDependents(tx, id)
			if err != nil {
				return configChange{}, err
			}
			if deps[id].InUse() {
				return configChange{}, ErrProviderSourceInUse
			}
			// The catalogue cascades by foreign key; delete it explicitly so
			// the result does not depend on the connection's FK enforcement.
			err = tx.Where("source_id = ?", id).Delete(&ProviderSourceEntry{}).Error
			if err != nil {
				return configChange{}, fmt.Errorf("delete source catalogue: %w", err)
			}
			res := tx.Delete(&ProviderSource{}, id)
			if res.Error != nil {
				return configChange{}, fmt.Errorf("delete provider source: %w", res.Error)
			}
			if res.RowsAffected == 0 {
				return configChange{}, ErrProviderSourceNotFound
			}
			old := sourceAuditView{
				ID: src.ID, Name: src.Name, Type: src.Type, Description: src.Description,
				Enabled: src.Enabled, ExpiresAt: src.ExpiresAt,
			}
			return configChange{targetID: id, oldValue: old, newValue: nil}, nil
		})
}

// DeleteBuilder physically deletes a subscription builder that nothing depends
// on, together with its source links and rules. version must match the stored
// row (ErrBuilderVersionConflict), so a builder changed in another tab is never
// deleted by a stale screen. ErrBuilderNotFound for a missing row,
// ErrBuilderInUse while a plan or a subscription still references it.
func (s *Service) DeleteBuilder(ctx context.Context, meta AdminConfigMeta, id uint, version int) (*AdminConfigResult, error) {
	if id == 0 || version <= 0 {
		return nil, fmt.Errorf("%w: id/version", ErrAdminInvalidRequest)
	}
	payload := struct {
		ID      uint `json:"id"`
		Version int  `json:"version"`
	}{id, version}
	return s.runAdminConfigMutation(ctx, meta, AdminActionBuilderDeleted, AdminTargetBuilder, id, payload,
		func(tx *gorm.DB, _ time.Time) (configChange, error) {
			claim := tx.Model(&SubscriptionBuilder{}).Where("id = ?", id).UpdateColumn("version", gorm.Expr("version"))
			if claim.Error != nil {
				return configChange{}, fmt.Errorf("lock subscription builder: %w", claim.Error)
			}
			if claim.RowsAffected == 0 {
				return configChange{}, ErrBuilderNotFound
			}
			var b SubscriptionBuilder
			err := tx.First(&b, id).Error
			if err != nil {
				return configChange{}, fmt.Errorf("load subscription builder: %w", err)
			}
			if b.Version != version {
				return configChange{}, ErrBuilderVersionConflict
			}
			deps, err := builderDependents(tx, id)
			if err != nil {
				return configChange{}, err
			}
			if deps[id].InUse() {
				return configChange{}, ErrBuilderInUse
			}
			err = tx.Where("builder_id = ?", id).Delete(&SubscriptionBuilderItem{}).Error
			if err != nil {
				return configChange{}, fmt.Errorf("delete builder rules: %w", err)
			}
			err = tx.Where("builder_id = ?", id).Delete(&SubscriptionBuilderSource{}).Error
			if err != nil {
				return configChange{}, fmt.Errorf("delete builder sources: %w", err)
			}
			res := tx.Delete(&SubscriptionBuilder{}, id)
			if res.Error != nil {
				return configChange{}, fmt.Errorf("delete subscription builder: %w", res.Error)
			}
			if res.RowsAffected == 0 {
				return configChange{}, ErrBuilderNotFound
			}
			return configChange{targetID: id, oldValue: builderView(&b), newValue: nil}, nil
		})
}
