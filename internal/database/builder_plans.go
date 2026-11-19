package database

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

// Sale plans of subscription builders.
//
// A plan is the internal link "subscription -> builder": a product points at a
// plan and the plan points at its default builder. The admin panel does not
// expose plans any more: a tariff is sold on a builder ("сборка") and the plan
// behind it is created, named and removed automatically:
//
//   - the sale plan of a builder is its oldest non-system plan;
//   - it is created on the first tariff of the builder and named after it;
//   - a legacy plan without a builder is adopted by the builder a tariff of
//     that plan is moved to, so its existing subscribers get the content too;
//   - renaming the builder renames the sale plan (the name is shown in the
//     users list, the journal and warm-up messages);
//   - an empty sale plan (no tariffs, no subscriptions) is deleted with the
//     builder and never blocks its deletion.

// planMaxNameLength is the size of plans.name.
const planMaxNameLength = 50

// IsSystemPlanName reports the trial and free plans: they are resolved by
// name (exactly, like checkTariffPlan), never sold and never renamed.
func IsSystemPlanName(name string) bool {
	return name == TrialPlanName || name == FreePlanName
}

// looksLikeSystemPlanName also covers other spellings ("Free", "TRIAL"): a
// generated plan name never takes them, so it cannot be confused with the
// system plans.
func looksLikeSystemPlanName(name string) bool {
	return strings.EqualFold(name, TrialPlanName) || strings.EqualFold(name, FreePlanName)
}

var systemPlanNames = []string{TrialPlanName, FreePlanName}

// builderSalePlan returns the plan tariffs of builderID are sold on, nil when
// the builder has none yet.
func builderSalePlan(tx *gorm.DB, builderID uint) (*Plan, error) {
	var plans []Plan
	err := tx.Where("subscription_builder_id = ? AND name NOT IN ?", builderID, systemPlanNames).
		Order("id ASC").Limit(1).Find(&plans).Error
	if err != nil {
		return nil, fmt.Errorf("load builder sale plan: %w", err)
	}
	if len(plans) == 0 {
		return nil, nil
	}
	return &plans[0], nil
}

func truncateRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return strings.TrimSpace(string(runes[:limit]))
}

// freePlanName derives a unique plans.name from want: want itself (cut to the
// column size), otherwise "want #2", "want #3", ... exceptID is the plan being
// renamed (its own name is free for it).
func freePlanName(tx *gorm.DB, want string, exceptID uint) (string, error) {
	base := strings.TrimSpace(want)
	if base == "" {
		base = "plan"
	}
	for n := 1; n <= 10_000; n++ {
		suffix := ""
		if n > 1 {
			suffix = fmt.Sprintf(" #%d", n)
		}
		candidate := truncateRunes(base, planMaxNameLength-len([]rune(suffix))) + suffix
		if looksLikeSystemPlanName(candidate) {
			continue
		}
		var taken int64
		err := tx.Model(&Plan{}).Where("name = ? AND id <> ?", candidate, exceptID).Count(&taken).Error
		if err != nil {
			return "", fmt.Errorf("check plan name: %w", err)
		}
		if taken == 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no free plan name for a builder")
}

// renamePlanAfterBuilder keeps a sale plan named after its builder.
func renamePlanAfterBuilder(tx *gorm.DB, plan *Plan, builderName string, now time.Time) error {
	name, err := freePlanName(tx, builderName, plan.ID)
	if err != nil {
		return err
	}
	if name == plan.Name {
		return nil
	}
	err = tx.Model(&Plan{}).Where("id = ?", plan.ID).Updates(map[string]any{"name": name, "updated_at": now}).Error
	if err != nil {
		return fmt.Errorf("rename builder plan: %w", err)
	}
	plan.Name = name
	return nil
}

// syncBuilderPlanName renames the sale plan of a builder after the builder.
// A builder without a sale plan has nothing to rename.
func syncBuilderPlanName(tx *gorm.DB, builderID uint, builderName string, now time.Time) error {
	plan, err := builderSalePlan(tx, builderID)
	if err != nil || plan == nil {
		return err
	}
	return renamePlanAfterBuilder(tx, plan, builderName, now)
}

// ensureBuilderSalePlan returns the plan a tariff of builderID is sold on,
// creating it when the builder has none. currentPlanID is the plan of the
// tariff being edited (0 for a new tariff):
//
//   - it is kept when it already serves the builder (no needless move);
//   - a non-system plan without a builder is adopted by the builder;
//   - otherwise the builder's sale plan is used or created.
//
// A missing builder is an invalid "builder_id" field of the tariff.
func ensureBuilderSalePlan(tx *gorm.DB, builderID, currentPlanID uint, now time.Time) (uint, error) {
	var b SubscriptionBuilder
	err := tx.Select("id", "name").First(&b, builderID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, invalidTariff("builder_id")
	}
	if err != nil {
		return 0, fmt.Errorf("load tariff builder: %w", err)
	}

	var current *Plan
	if currentPlanID != 0 {
		var plan Plan
		err = tx.First(&plan, currentPlanID).Error
		switch {
		case err == nil && !IsSystemPlanName(plan.Name):
			current = &plan
		case err != nil && !errors.Is(err, gorm.ErrRecordNotFound):
			return 0, fmt.Errorf("load tariff plan: %w", err)
		}
	}
	if current != nil && current.SubscriptionBuilderID != nil && *current.SubscriptionBuilderID == builderID {
		return current.ID, renamePlanAfterBuilder(tx, current, b.Name, now)
	}

	plan, err := builderSalePlan(tx, builderID)
	if err != nil {
		return 0, err
	}
	if plan == nil && current != nil && current.SubscriptionBuilderID == nil {
		err = tx.Model(&Plan{}).Where("id = ?", current.ID).
			Updates(map[string]any{"subscription_builder_id": builderID, "updated_at": now}).Error
		if err != nil {
			return 0, fmt.Errorf("adopt plan by builder: %w", err)
		}
		plan = current
	}
	if plan == nil {
		name, err := freePlanName(tx, b.Name, 0)
		if err != nil {
			return 0, err
		}
		created := Plan{Name: name, IsActive: true, SubscriptionBuilderID: &builderID}
		err = tx.Create(&created).Error
		if err != nil {
			return 0, fmt.Errorf("create builder plan: %w", err)
		}
		return created.ID, nil
	}
	return plan.ID, renamePlanAfterBuilder(tx, plan, b.Name, now)
}

// BuilderSales is how a builder is sold and used right now.
type BuilderSales struct {
	// PlanID is the sale plan; nil until the builder has a tariff.
	PlanID *uint `json:"plan_id"`
	// Clients counts the active subscriptions the builder serves: through a
	// plan whose default it is, or through a per-subscription override.
	Clients int64 `json:"clients"`
}

func builderSales(tx *gorm.DB, onlyID uint) (map[uint]BuilderSales, error) {
	out := map[uint]BuilderSales{}
	var plans []Plan
	query := tx.Select("id", "name", "subscription_builder_id").Where("subscription_builder_id IS NOT NULL")
	if onlyID != 0 {
		query = query.Where("subscription_builder_id = ?", onlyID)
	}
	err := query.Order("id ASC").Find(&plans).Error
	if err != nil {
		return nil, fmt.Errorf("load builder plans: %w", err)
	}
	for i := range plans {
		p := plans[i]
		if IsSystemPlanName(p.Name) {
			continue
		}
		sales := out[*p.SubscriptionBuilderID]
		if sales.PlanID == nil {
			id := p.ID
			sales.PlanID = &id
			out[*p.SubscriptionBuilderID] = sales
		}
	}

	// The same priority as ResolveSubscriptionBuilder: the override, then the
	// plan default.
	const clientsSQL = `
SELECT COALESCE(s.subscription_builder_id, p.subscription_builder_id) AS builder_id, COUNT(*) AS n
FROM subscriptions s
LEFT JOIN plans p ON p.id = s.plan_id
WHERE s.status = ? AND COALESCE(s.subscription_builder_id, p.subscription_builder_id) IS NOT NULL
  AND (? = 0 OR COALESCE(s.subscription_builder_id, p.subscription_builder_id) = ?)
GROUP BY 1`
	var counts []struct {
		BuilderID uint
		N         int64
	}
	err = tx.Raw(clientsSQL, string(SubscriptionStatusActive), onlyID, onlyID).Scan(&counts).Error
	if err != nil {
		return nil, fmt.Errorf("count builder clients: %w", err)
	}
	for _, c := range counts {
		sales := out[c.BuilderID]
		sales.Clients = c.N
		out[c.BuilderID] = sales
	}
	return out, nil
}

// BuilderSalesAll returns the sale state of every builder that has any.
func (s *Service) BuilderSalesAll(ctx context.Context) (map[uint]BuilderSales, error) {
	var out map[uint]BuilderSales
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var err error
		out, err = builderSales(tx, 0)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// BuilderSalesFor returns the sale state of one builder.
func (s *Service) BuilderSalesFor(ctx context.Context, builderID uint) (BuilderSales, error) {
	var out BuilderSales
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		all, err := builderSales(tx, builderID)
		if err != nil {
			return err
		}
		out = all[builderID]
		return nil
	})
	return out, err
}
