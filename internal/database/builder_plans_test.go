package database

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Sale plans: a tariff is sold on a builder and the plan behind it is created,
// adopted, renamed and removed automatically (builder_plans.go).

func (f *tariffFixture) builder(name string) uint {
	f.t.Helper()
	res, err := f.svc.CreateBuilder(f.ctx, f.meta(), BuilderCreateInput{Name: name, Enabled: true})
	require.NoError(f.t, err)
	return res.TargetID
}

// onBuilder is a tariff sold on a builder: no explicit plan.
func (f *tariffFixture) onBuilder(name string, price int64, builderID uint) TariffInput {
	in := f.input(name, price)
	in.PlanID, in.BuilderID = 0, builderID
	return in
}

func (f *tariffFixture) planRow(id uint) *Plan {
	f.t.Helper()
	var p Plan
	require.NoError(f.t, f.svc.db.First(&p, id).Error)
	return &p
}

func (f *tariffFixture) planCount(where string, args ...any) int64 {
	f.t.Helper()
	var n int64
	require.NoError(f.t, f.svc.db.Model(&Plan{}).Where(where, args...).Count(&n).Error)
	return n
}

func TestTariffOnBuilder_CreatesAndReusesSalePlan(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)
	builderID := f.builder("Европа")

	// A builder nobody sells has no plan yet.
	sales, err := f.svc.BuilderSalesFor(f.ctx, builderID)
	require.NoError(t, err)
	assert.Nil(t, sales.PlanID)
	assert.Zero(t, f.planCount("subscription_builder_id = ?", builderID))

	res, err := f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, builderID))
	require.NoError(t, err)
	first := f.product(res.TargetID)
	plan := f.planRow(first.PlanID)
	assert.Equal(t, "Европа", plan.Name, "the plan is named after the builder")
	assert.True(t, plan.IsActive)
	require.NotNil(t, plan.SubscriptionBuilderID)
	assert.Equal(t, builderID, *plan.SubscriptionBuilderID)

	// The second tariff of the builder is sold on the same plan.
	res, err = f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Год", 199000, builderID))
	require.NoError(t, err)
	assert.Equal(t, plan.ID, f.product(res.TargetID).PlanID)
	assert.EqualValues(t, 1, f.planCount("subscription_builder_id = ?", builderID))

	row, err := f.svc.GetTariff(f.ctx, first.ID)
	require.NoError(t, err)
	assert.Equal(t, "Европа", row.PlanBuilderName)
	require.NotNil(t, row.PlanBuilderID)
	assert.Equal(t, builderID, *row.PlanBuilderID)

	// Sales: the plan and the active subscriptions the builder serves, through
	// the plan or through a per-subscription override.
	onPlan := createTestSubscription(t, f.svc, 880001, "on-plan", "sale-plan-client")
	require.NoError(t, f.svc.db.Model(onPlan).Update("plan_id", plan.ID).Error)
	override := createTestSubscription(t, f.svc, 880002, "override", "sale-override-client")
	require.NoError(t, f.svc.db.Model(override).Update("subscription_builder_id", builderID).Error)
	revoked := createTestSubscription(t, f.svc, 880003, "revoked", "sale-revoked-client")
	require.NoError(t, f.svc.db.Model(revoked).Updates(map[string]any{"plan_id": plan.ID, "status": "revoked"}).Error)

	sales, err = f.svc.BuilderSalesFor(f.ctx, builderID)
	require.NoError(t, err)
	require.NotNil(t, sales.PlanID)
	assert.Equal(t, plan.ID, *sales.PlanID)
	assert.EqualValues(t, 2, sales.Clients)

	all, err := f.svc.BuilderSalesAll(f.ctx)
	require.NoError(t, err)
	assert.Equal(t, sales, all[builderID])
}

func TestTariffOnBuilder_PlanFollowsBuilderName(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)
	builderID := f.builder("Европа")
	res, err := f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, builderID))
	require.NoError(t, err)
	planID := f.product(res.TargetID).PlanID

	// The configuration save (the editor) renames the plan with the builder.
	b, err := f.svc.GetBuilder(f.ctx, builderID)
	require.NoError(t, err)
	_, err = f.svc.SaveBuilderConfiguration(f.ctx, f.meta(), BuilderConfigurationInput{
		ID: builderID, Version: b.Version, Name: "Только Германия", Enabled: true, SourceIDs: []uint{}, Items: []BuilderConfigItem{},
	})
	require.NoError(t, err)
	assert.Equal(t, "Только Германия", f.planRow(planID).Name)

	// So does the metadata update.
	b, err = f.svc.GetBuilder(f.ctx, builderID)
	require.NoError(t, err)
	_, err = f.svc.UpdateBuilder(f.ctx, f.meta(), BuilderUpdateInput{ID: builderID, Version: b.Version, Name: "Германия и Нидерланды", Enabled: true})
	require.NoError(t, err)
	assert.Equal(t, "Германия и Нидерланды", f.planRow(planID).Name)

	// A builder without tariffs has no plan to rename: nothing is created.
	other := f.builder("Без тарифов")
	ob, err := f.svc.GetBuilder(f.ctx, other)
	require.NoError(t, err)
	_, err = f.svc.UpdateBuilder(f.ctx, f.meta(), BuilderUpdateInput{ID: other, Version: ob.Version, Name: "Всё ещё без тарифов", Enabled: true})
	require.NoError(t, err)
	assert.Zero(t, f.planCount("subscription_builder_id = ?", other))
}

func TestTariffOnBuilder_PlanNamesStayUnique(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)

	// The name is taken by an unrelated plan: the sale plan gets a suffix.
	require.NoError(t, f.svc.db.Create(&Plan{Name: "Европа", IsActive: true}).Error)
	europe := f.builder("Европа")
	res, err := f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, europe))
	require.NoError(t, err)
	assert.Equal(t, "Европа #2", f.planRow(f.product(res.TargetID).PlanID).Name)

	// A builder called like a system plan never takes that name.
	free := f.builder("Free")
	res, err = f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, free))
	require.NoError(t, err)
	plan := f.planRow(f.product(res.TargetID).PlanID)
	assert.Equal(t, "Free #2", plan.Name)
	assert.False(t, IsSystemPlanName(plan.Name))

	// A long builder name is cut to the column size.
	long := f.builder("Очень длинное название сборки для проверки ограничения длины имени плана")
	res, err = f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, long))
	require.NoError(t, err)
	assert.LessOrEqual(t, len([]rune(f.planRow(f.product(res.TargetID).PlanID).Name)), planMaxNameLength)
}

func TestTariffOnBuilder_AdoptsLegacyPlanWithoutBuilder(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)

	// A legacy plan nobody can rename in the panel, already sold.
	require.NoError(t, f.svc.db.Model(f.plan).Update("name", "test-customer-1").Error)
	legacy := f.create("Месяц", 19900)
	f.useInOrder(legacy, 881001)
	builderID := f.builder("Европа")

	// Choosing a builder for the tariff does not move it: the plan (and with
	// it every existing subscriber) gets the builder and its name.
	in := TariffUpdateInput{ID: legacy.ID, Version: legacy.Version, TariffInput: f.onBuilder("Месяц", 19900, builderID)}
	res, err := f.svc.UpdateTariff(f.ctx, f.meta(), in)
	require.NoError(t, err)
	assert.Equal(t, legacy.ID, res.TargetID, "an adopted plan is not a change of the purchase terms")
	assert.Equal(t, f.plan.ID, f.product(legacy.ID).PlanID)
	plan := f.planRow(f.plan.ID)
	assert.Equal(t, "Европа", plan.Name)
	require.NotNil(t, plan.SubscriptionBuilderID)
	assert.Equal(t, builderID, *plan.SubscriptionBuilderID)

	// Saving again with the same builder keeps everything in place.
	current := f.product(legacy.ID)
	in = TariffUpdateInput{ID: legacy.ID, Version: current.Version, TariffInput: f.onBuilder("Месяц", 19900, builderID)}
	res, err = f.svc.UpdateTariff(f.ctx, f.meta(), in)
	require.NoError(t, err)
	assert.Equal(t, legacy.ID, res.TargetID)
	assert.EqualValues(t, 1, f.planCount("subscription_builder_id = ?", builderID))
}

func TestTariffOnBuilder_MovingAUsedTariffCreatesAVersion(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)
	europe, asia := f.builder("Европа"), f.builder("Азия")
	res, err := f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, europe))
	require.NoError(t, err)
	original := f.product(res.TargetID)
	f.useInOrder(original, 882001)

	// Buyers keep what they bought: the tariff on another builder is a new
	// version on that builder's plan.
	in := TariffUpdateInput{ID: original.ID, Version: original.Version, TariffInput: f.onBuilder("Месяц", 19900, asia)}
	res, err = f.svc.UpdateTariff(f.ctx, f.meta(), in)
	require.NoError(t, err)
	require.NotEqual(t, original.ID, res.TargetID)
	successor := f.product(res.TargetID)
	assert.Equal(t, "Азия", f.planRow(successor.PlanID).Name)
	retired := f.product(original.ID)
	assert.False(t, retired.IsActive)
	assert.Equal(t, original.PlanID, retired.PlanID)
	assert.Equal(t, "Европа", f.planRow(retired.PlanID).Name)
}

func TestTariffOnBuilder_RejectsUnknownBuilder(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)
	before := f.auditCount()

	_, err := f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, 424242))
	var field *TariffFieldError
	require.True(t, errors.As(err, &field))
	assert.Equal(t, "builder_id", field.Field)

	// Neither a plan nor a builder.
	in := f.input("Месяц", 19900)
	in.PlanID = 0
	_, err = f.svc.CreateTariff(f.ctx, f.meta(), in)
	require.True(t, errors.As(err, &field))
	assert.Equal(t, "plan_id", field.Field)

	assert.Equal(t, before, f.auditCount(), "a rejected tariff is not audited")
	var products int64
	require.NoError(t, f.svc.db.Model(&Product{}).Count(&products).Error)
	assert.Zero(t, products)
}

// Assigning a builder to a plan directly (the «сборка тарифа» dialog of the
// user page, the «Бесплатный доступ» panel) keeps the same naming rule.
func TestSetPlanBuilder_KeepsPlanNames(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)
	europe, asia := f.builder("Европа"), f.builder("Азия")

	// A legacy plan nobody can rename in the panel gets the name of its builder.
	require.NoError(t, f.svc.db.Model(f.plan).Update("name", "test-customer-1").Error)
	_, err := f.svc.SetPlanBuilder(f.ctx, f.meta(), f.plan.ID, &europe)
	require.NoError(t, err)
	plan := f.planRow(f.plan.ID)
	assert.Equal(t, "Европа", plan.Name)
	require.NotNil(t, plan.SubscriptionBuilderID)
	assert.Equal(t, europe, *plan.SubscriptionBuilderID)

	// Moving it to another builder renames it again.
	_, err = f.svc.SetPlanBuilder(f.ctx, f.meta(), f.plan.ID, &asia)
	require.NoError(t, err)
	assert.Equal(t, "Азия", f.planRow(f.plan.ID).Name)

	// Clearing the builder keeps the last name: there is nothing to follow.
	_, err = f.svc.SetPlanBuilder(f.ctx, f.meta(), f.plan.ID, nil)
	require.NoError(t, err)
	plan = f.planRow(f.plan.ID)
	assert.Equal(t, "Азия", plan.Name)
	assert.Nil(t, plan.SubscriptionBuilderID)

	// The system plans are resolved by name: they are never renamed.
	free, err := f.svc.GetPlanByName(f.ctx, FreePlanName)
	require.NoError(t, err)
	_, err = f.svc.SetPlanBuilder(f.ctx, f.meta(), free.ID, &europe)
	require.NoError(t, err)
	freeRow := f.planRow(free.ID)
	assert.Equal(t, FreePlanName, freeRow.Name)
	require.NotNil(t, freeRow.SubscriptionBuilderID)
	assert.Equal(t, europe, *freeRow.SubscriptionBuilderID)
}

func TestDeleteBuilder_SalePlan(t *testing.T) {
	t.Parallel()
	f := newTariffFixture(t)
	builderID := f.builder("Европа")
	res, err := f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, builderID))
	require.NoError(t, err)
	tariff := f.product(res.TargetID)
	version := func() int {
		b, err := f.svc.GetBuilder(f.ctx, builderID)
		require.NoError(t, err)
		return b.Version
	}

	// A builder with a tariff is in use and the plan is named.
	deps, err := f.svc.BuilderDependentsFor(f.ctx, builderID)
	require.NoError(t, err)
	assert.Equal(t, []DependentRef{{ID: tariff.PlanID, Name: "Европа"}}, deps.Plans)
	_, err = f.svc.DeleteBuilder(f.ctx, f.meta(), builderID, version())
	require.ErrorIs(t, err, ErrBuilderInUse)

	// Without tariffs and subscribers the sale plan is internal: it does not
	// block the deletion and goes away with the builder.
	_, err = f.svc.DeleteTariff(f.ctx, f.meta(), tariff.ID, tariff.Version)
	require.NoError(t, err)
	deps, err = f.svc.BuilderDependentsFor(f.ctx, builderID)
	require.NoError(t, err)
	assert.False(t, deps.InUse())
	_, err = f.svc.DeleteBuilder(f.ctx, f.meta(), builderID, version())
	require.NoError(t, err)
	assert.Zero(t, f.planCount("id = ?", tariff.PlanID), "the empty sale plan is removed with the builder")
	assert.EqualValues(t, 1, f.planCount("name = ?", FreePlanName), "system plans are never touched")

	// A subscriber left on the plan keeps the builder.
	kept := f.builder("Азия")
	res, err = f.svc.CreateTariff(f.ctx, f.meta(), f.onBuilder("Месяц", 19900, kept))
	require.NoError(t, err)
	keptTariff := f.product(res.TargetID)
	sub := createTestSubscription(t, f.svc, 883001, "kept", "kept-plan-client")
	require.NoError(t, f.svc.db.Model(sub).Updates(map[string]any{"plan_id": keptTariff.PlanID, "status": "revoked"}).Error)
	_, err = f.svc.DeleteTariff(f.ctx, f.meta(), keptTariff.ID, keptTariff.Version)
	require.NoError(t, err)
	b, err := f.svc.GetBuilder(f.ctx, kept)
	require.NoError(t, err)
	_, err = f.svc.DeleteBuilder(f.ctx, f.meta(), kept, b.Version)
	require.ErrorIs(t, err, ErrBuilderInUse)
}
