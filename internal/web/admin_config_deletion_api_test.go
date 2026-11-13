package web

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Validity end of a provider source (expires_at) and deletion of sources and
// builders (DELETE /admin/api/sources/{id}, /admin/api/builders/{id}) through
// the handler installed by Start, the real SQLite repository and the
// production fetcher. No response may carry the upstream URL or credentials
// (sourceAPIFixture.text asserts it on every body read here).

// withSourceExpiry is createBody with a raw JSON expires_at member.
func (f *sourceAPIFixture) withSourceExpiry(name, rawExpiry string) string {
	return strings.Replace(f.createBody(name, ""), `"enabled":true}`, `"enabled":true,"expires_at":`+rawExpiry+`}`, 1)
}

func (f *sourceAPIFixture) mustCreateSource(body string) service.SourceView {
	f.t.Helper()
	resp := f.do(http.MethodPost, "/admin/api/sources", f.withCSRF(), withJSON(body))
	require.Equal(f.t, http.StatusCreated, resp.StatusCode)
	var created struct {
		Source service.SourceView `json:"source"`
	}
	require.NoError(f.t, jsonUnmarshal(f.text(resp), &created))
	return created.Source
}

func (f *sourceAPIFixture) getSource(id uint) service.SourceView {
	f.t.Helper()
	resp := f.do(http.MethodGet, sourcePath(id, ""))
	require.Equal(f.t, http.StatusOK, resp.StatusCode)
	var out service.SourceView
	require.NoError(f.t, jsonUnmarshal(f.text(resp), &out))
	return out
}

func (f *sourceAPIFixture) getBuilder(id uint) service.BuilderView {
	f.t.Helper()
	resp := f.do(http.MethodGet, builderPath(id, ""))
	require.Equal(f.t, http.StatusOK, resp.StatusCode)
	var out service.BuilderView
	require.NoError(f.t, jsonUnmarshal(f.text(resp), &out))
	return out
}

// expectSourceField asserts 400 invalid_source naming the field.
func (f *sourceAPIFixture) expectSourceField(resp *http.Response, field string) {
	f.t.Helper()
	require.Equal(f.t, http.StatusBadRequest, resp.StatusCode)
	assert.Equal(f.t, map[string]any{"error": "invalid_source", "field": field}, f.raw(resp))
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminSourceAPI_ExpiryOnCreateAndUpdate(t *testing.T) {
	f := newSourceAPIFixture(t)
	f.login()
	now := time.Now().UTC()

	// A past, malformed or mistyped end is rejected before anything is stored
	// or fetched.
	for _, raw := range []string{
		`"` + now.Add(-time.Hour).Format(time.RFC3339) + `"`, `"tomorrow"`, `"2030-12-01 10:00"`, `1893456000`, `"10000-01-01T00:00:00Z"`,
	} {
		f.expectSourceField(f.do(http.MethodPost, "/admin/api/sources", f.withCSRF(), withJSON(f.withSourceExpiry("Bad", raw))), "expires_at")
	}
	assert.Zero(t, f.hits.Load())
	var stored int64
	require.NoError(t, f.db.GetDB().Model(&database.ProviderSource{}).Count(&stored).Error)
	assert.Zero(t, stored)

	// No member and an explicit null both mean "no limit".
	unlimited := f.mustCreateSource(f.createBody("Unlimited", ""))
	assert.Nil(t, unlimited.ExpiresAt)
	assert.False(t, unlimited.Expired)
	assert.Nil(t, f.mustCreateSource(f.withSourceExpiry("Null", "null")).ExpiresAt)

	// The end is stored in UTC whatever offset the browser sent.
	until := now.Add(48 * time.Hour).Truncate(time.Second)
	local := until.In(time.FixedZone("msk", 3*60*60)).Format(time.RFC3339)
	src := f.mustCreateSource(f.withSourceExpiry("Limited", `"`+local+`"`))
	require.NotNil(t, src.ExpiresAt)
	assert.True(t, until.Equal(*src.ExpiresAt))
	assert.False(t, src.Expired)
	raw := f.text(f.do(http.MethodGet, sourcePath(src.ID, "")))
	assert.Contains(t, raw, `"expires_at":"`+until.Format(time.RFC3339)+`"`)
	assert.Contains(t, raw, `"expired":false`)
	assert.Contains(t, raw, `"dependents":{"builders":[],"subscriptions":0}`)

	patch := func(body string) *http.Response {
		return f.do(http.MethodPatch, sourcePath(src.ID, ""), f.withCSRF(), withJSON(body))
	}
	patched := func(body string) service.SourceView {
		t.Helper()
		resp := patch(body)
		require.Equal(t, http.StatusOK, resp.StatusCode, body)
		var out service.SourceView
		require.NoError(t, jsonUnmarshal(f.text(resp), &out))
		return out
	}

	// A metadata edit without the member keeps the stored end.
	renamed := patched(`{"name":"Renamed","description":"d","type":"auto"}`)
	assert.Equal(t, "Renamed", renamed.Name)
	require.NotNil(t, renamed.ExpiresAt)
	assert.True(t, until.Equal(*renamed.ExpiresAt))

	// A new end replaces it, null clears it, a past one is rejected and
	// changes nothing.
	later := until.Add(24 * time.Hour)
	moved := patched(fmt.Sprintf(`{"name":"Renamed","description":"d","type":"auto","expires_at":%q}`, later.Format(time.RFC3339)))
	require.NotNil(t, moved.ExpiresAt)
	assert.True(t, later.Equal(*moved.ExpiresAt))
	f.expectSourceField(patch(fmt.Sprintf(`{"name":"X","description":"","type":"auto","expires_at":%q}`, now.Add(-time.Minute).Format(time.RFC3339))), "expires_at")
	f.expectSourceField(patch(`{"name":"X","description":"","type":"auto","expires_at":"soon"}`), "expires_at")
	kept := f.getSource(src.ID)
	assert.Equal(t, "Renamed", kept.Name)
	require.NotNil(t, kept.ExpiresAt)
	assert.True(t, later.Equal(*kept.ExpiresAt))
	assert.Nil(t, patched(`{"name":"Renamed","description":"d","type":"auto","expires_at":null}`).ExpiresAt)
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminSourceAPI_ExpiredSourceIsUnusableButManageable(t *testing.T) {
	f := newSourceAPIFixture(t)
	f.login()
	ctx := context.Background()

	src := f.mustCreateSource(f.withSourceExpiry("Expiring", `"`+time.Now().UTC().Add(time.Hour).Format(time.RFC3339)+`"`))
	usable := func() error {
		t.Helper()
		stored, err := f.db.GetProviderSourceByID(ctx, src.ID)
		require.NoError(t, err)
		_, _, err = stored.RequestConfiguration()
		return err
	}
	require.NoError(t, usable())

	// The term runs out (no admin action, only the clock).
	past := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	require.NoError(t, f.db.GetDB().Model(&database.ProviderSource{}).Where("id = ?", src.ID).UpdateColumn("expires_at", past).Error)

	expired := f.getSource(src.ID)
	assert.True(t, expired.Expired)
	assert.True(t, expired.Enabled, "expiry does not flip the admin switch")
	require.NotNil(t, expired.ExpiresAt)
	assert.True(t, past.Equal(*expired.ExpiresAt))
	// The single runtime check (/sub, preview, monitor, trial, purchase policy).
	assert.ErrorIs(t, usable(), database.ErrProviderSourceUnusable)

	var list struct {
		Sources []service.SourceView `json:"sources"`
	}
	require.NoError(t, jsonUnmarshal(f.text(f.do(http.MethodGet, "/admin/api/sources")), &list))
	require.Len(t, list.Sources, 1)
	assert.True(t, list.Sources[0].Expired)

	// The admin can still sync it (e.g. to check the provider after renewing).
	hits := f.hits.Load()
	resp := f.do(http.MethodPost, sourcePath(src.ID, "/refresh"), f.withCSRF(), withJSON("{}"))
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var synced syncWire
	require.NoError(t, jsonUnmarshal(f.text(resp), &synced))
	assert.Equal(t, "ok", synced.Status)
	assert.True(t, synced.Source.Expired)
	assert.Equal(t, hits+1, f.hits.Load())

	// Renaming it is not a new deadline: without the member and with the
	// stored value re-sent the past end is kept, a different past one is not.
	patch := func(body string) *http.Response {
		return f.do(http.MethodPatch, sourcePath(src.ID, ""), f.withCSRF(), withJSON(body))
	}
	for i, body := range []string{
		`{"name":"Old 1","description":"","type":"auto"}`,
		fmt.Sprintf(`{"name":"Old 2","description":"","type":"auto","expires_at":%q}`, past.Format(time.RFC3339)),
	} {
		resp := patch(body)
		require.Equal(t, http.StatusOK, resp.StatusCode, "edit %d", i)
		var out service.SourceView
		require.NoError(t, jsonUnmarshal(f.text(resp), &out))
		assert.True(t, out.Expired, "edit %d", i)
		require.NotNil(t, out.ExpiresAt)
		assert.True(t, past.Equal(*out.ExpiresAt), "edit %d", i)
	}
	f.expectSourceField(patch(fmt.Sprintf(`{"name":"Old 3","description":"","type":"auto","expires_at":%q}`,
		past.Add(-time.Hour).Format(time.RFC3339))), "expires_at")

	// Extending the term brings the source back without any other action.
	resp = patch(fmt.Sprintf(`{"name":"Renewed","description":"","type":"auto","expires_at":%q}`,
		time.Now().UTC().Add(30*24*time.Hour).Format(time.RFC3339)))
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var renewed service.SourceView
	require.NoError(t, jsonUnmarshal(f.text(resp), &renewed))
	assert.False(t, renewed.Expired)
	require.NoError(t, usable())
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminAPI_DeleteSourceAndBuilderOnlyWhenUnused(t *testing.T) {
	f := newSourceAPIFixture(t)
	f.login()
	ctx := context.Background()

	srcA := f.mustCreateSource(f.createBody("Provider A", ""))
	srcB := f.mustCreateSource(f.createBody("Provider B", ""))

	resp := f.do(http.MethodPost, "/admin/api/builders", f.withCSRF(), withJSON(
		`{"request_key":"del-create","name":"FINLAN","description":"","enabled":true,"profile_title":"","support_url":"","announce":""}`))
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var created struct {
		Builder service.BuilderView `json:"builder"`
	}
	rawBuilder := f.text(resp)
	require.NoError(t, jsonUnmarshal(rawBuilder, &created))
	assert.Contains(t, rawBuilder, `"dependents":{"plans":[],"subscriptions":0}`)
	builderID := created.Builder.ID

	resp = f.do(http.MethodPut, builderPath(builderID, "/sources"), f.withCSRF(), withJSON(fmt.Sprintf(`{"source_ids":[%d]}`, srcA.ID)))
	require.Equal(t, http.StatusOK, resp.StatusCode)
	f.text(resp)

	del := func(path, body string, opts ...adminRequestOption) *http.Response {
		return f.do(http.MethodDelete, path, append([]adminRequestOption{withJSON(body)}, opts...)...)
	}
	type deleted struct {
		Deleted uint                   `json:"deleted"`
		Audit   database.AdminAuditLog `json:"audit"`
	}
	countRows := func(model any, where string, arg uint) int64 {
		t.Helper()
		var n int64
		require.NoError(t, f.db.GetDB().Model(model).Where(where, arg).Count(&n).Error)
		return n
	}

	// --- Sources ------------------------------------------------------------
	// The linked source names its builder; the free one has no dependents.
	assert.Equal(t, database.SourceDependents{Builders: []database.DependentRef{{ID: builderID, Name: "FINLAN"}}}, f.getSource(srcA.ID).Dependents)
	assert.Equal(t, database.SourceDependents{Builders: []database.DependentRef{}}, f.getSource(srcB.ID).Dependents)
	var list struct {
		Sources []service.SourceView `json:"sources"`
	}
	require.NoError(t, jsonUnmarshal(f.text(f.do(http.MethodGet, "/admin/api/sources")), &list))
	require.Len(t, list.Sources, 2)
	for _, s := range list.Sources {
		assert.Equal(t, s.ID == srcA.ID, s.Dependents.InUse(), s.Name)
	}

	audits := f.auditCount()
	// Guards: CSRF, request key, unknown members, unknown row, used source.
	require.Equal(t, http.StatusForbidden, del(sourcePath(srcB.ID, ""), `{"request_key":"del-b"}`).StatusCode)
	f.expectError(del(sourcePath(srcB.ID, ""), `{}`, f.withCSRF()), http.StatusBadRequest, "invalid_request")
	f.expectError(del(sourcePath(srcB.ID, ""), `{"request_key":"del-b","force":true}`, f.withCSRF()), http.StatusBadRequest, "invalid_request")
	f.expectError(del(sourcePath(424242, ""), `{"request_key":"del-missing"}`, f.withCSRF()), http.StatusNotFound, "not_found")
	f.expectError(del(sourcePath(srcA.ID, ""), `{"request_key":"del-a-used"}`, f.withCSRF()), http.StatusConflict, "source_in_use")
	assert.Equal(t, audits, f.auditCount(), "rejections are not audited")
	assert.Equal(t, "Provider A", f.getSource(srcA.ID).Name)
	assert.EqualValues(t, 40, countRows(&database.ProviderSourceEntry{}, "source_id = ?", srcB.ID))

	// The unused source goes with its catalogue; the audit row has no credentials.
	resp = del(sourcePath(srcB.ID, ""), `{"request_key":"del-b"}`, f.withCSRF())
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var gone deleted
	require.NoError(t, jsonUnmarshal(f.text(resp), &gone))
	assert.Equal(t, srcB.ID, gone.Deleted)
	assert.Equal(t, string(database.AdminActionSourceDeleted), gone.Audit.Action)
	assert.Equal(t, srcB.ID, gone.Audit.TargetID)
	assert.Contains(t, gone.Audit.OldValue, "Provider B")
	assert.Equal(t, audits+1, f.auditCount())
	f.expectError(f.do(http.MethodGet, sourcePath(srcB.ID, "")), http.StatusNotFound, "not_found")
	assert.Zero(t, countRows(&database.ProviderSourceEntry{}, "source_id = ?", srcB.ID))
	assert.EqualValues(t, 40, countRows(&database.ProviderSourceEntry{}, "source_id = ?", srcA.ID), "other catalogues are untouched")

	// The same key replays the recorded deletion; for another row it conflicts;
	// a new key finds nothing.
	resp = del(sourcePath(srcB.ID, ""), `{"request_key":"del-b"}`, f.withCSRF())
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var replay deleted
	require.NoError(t, jsonUnmarshal(f.text(resp), &replay))
	assert.Equal(t, gone.Audit.ID, replay.Audit.ID)
	f.expectError(del(sourcePath(srcA.ID, ""), `{"request_key":"del-b"}`, f.withCSRF()), http.StatusConflict, "request_key_conflict")
	f.expectError(del(sourcePath(srcB.ID, ""), `{"request_key":"del-b-again"}`, f.withCSRF()), http.StatusNotFound, "not_found")
	assert.Equal(t, audits+1, f.auditCount())

	// --- Builders -----------------------------------------------------------
	free, err := f.db.GetPlanByName(ctx, database.FreePlanName)
	require.NoError(t, err)
	planPath := fmt.Sprintf("/admin/api/plans/%d/builder", free.ID)
	sub := &database.Subscription{TelegramID: 929292, ClientID: "del-api-client", SubscriptionID: "del-api-sub",
		Status: string(database.SubscriptionStatusActive), PlanID: free.ID}
	require.NoError(t, f.db.CreateSubscription(ctx, sub, ""))
	subPath := fmt.Sprintf("/admin/api/subscriptions/%d/builder", sub.ID)
	assign := func(path, key, builder string) {
		t.Helper()
		resp := f.do(http.MethodPost, path, f.withCSRF(), withJSON(fmt.Sprintf(`{"request_key":%q,"builder_id":%s}`, key, builder)))
		require.Equal(t, http.StatusOK, resp.StatusCode)
		_ = resp.Body.Close()
	}
	id := fmt.Sprint(builderID)
	delBuilder := func(key string, version int) *http.Response {
		return del(builderPath(builderID, ""), fmt.Sprintf(`{"request_key":%q,"version":%d}`, key, version), f.withCSRF())
	}

	// A plan default blocks the deletion and is named.
	assign(planPath, "del-plan-set", id)
	view := f.getBuilder(builderID)
	assert.Equal(t, database.BuilderDependents{Plans: []database.DependentRef{{ID: free.ID, Name: free.Name}}}, view.Dependents)
	f.expectError(delBuilder("del-builder-plan", view.Version), http.StatusConflict, "builder_in_use")
	assign(planPath, "del-plan-clear", "null")

	// So does a per-subscription override.
	assign(subPath, "del-sub-set", id)
	view = f.getBuilder(builderID)
	assert.Equal(t, database.BuilderDependents{Plans: []database.DependentRef{}, Subscriptions: 1}, view.Dependents)
	f.expectError(delBuilder("del-builder-sub", view.Version), http.StatusConflict, "builder_in_use")
	assign(subPath, "del-sub-clear", "null")

	view = f.getBuilder(builderID)
	assert.False(t, view.Dependents.InUse())
	var builders struct {
		Builders []service.BuilderView `json:"builders"`
	}
	require.NoError(t, jsonUnmarshal(f.text(f.do(http.MethodGet, "/admin/api/builders")), &builders))
	require.Len(t, builders.Builders, 1)
	assert.False(t, builders.Builders[0].Dependents.InUse())

	// Guards: a stale or missing version, an unknown row.
	audits = f.auditCount()
	f.expectError(delBuilder("del-builder-stale", view.Version+1), http.StatusConflict, "version_conflict")
	f.expectError(delBuilder("del-builder-nover", 0), http.StatusBadRequest, "invalid_request")
	f.expectError(del(builderPath(424242, ""), `{"request_key":"del-builder-missing","version":1}`, f.withCSRF()), http.StatusNotFound, "not_found")
	require.Equal(t, http.StatusForbidden, del(builderPath(builderID, ""), fmt.Sprintf(`{"request_key":"del-builder","version":%d}`, view.Version)).StatusCode)
	assert.Equal(t, audits, f.auditCount())
	assert.EqualValues(t, 1, countRows(&database.SubscriptionBuilderSource{}, "builder_id = ?", builderID))

	resp = delBuilder("del-builder", view.Version)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var goneBuilder deleted
	require.NoError(t, jsonUnmarshal(f.text(resp), &goneBuilder))
	assert.Equal(t, builderID, goneBuilder.Deleted)
	assert.Equal(t, string(database.AdminActionBuilderDeleted), goneBuilder.Audit.Action)
	assert.Contains(t, goneBuilder.Audit.OldValue, "FINLAN")
	f.expectError(f.do(http.MethodGet, builderPath(builderID, "")), http.StatusNotFound, "not_found")
	assert.Zero(t, countRows(&database.SubscriptionBuilderSource{}, "builder_id = ?", builderID))
	// Plans and subscriptions that used to reference it were never touched.
	var storedSub database.Subscription
	require.NoError(t, f.db.GetDB().First(&storedSub, sub.ID).Error)
	assert.Nil(t, storedSub.SubscriptionBuilderID)
	assert.Equal(t, string(database.SubscriptionStatusActive), storedSub.Status)

	// With its only builder gone the first source is free to delete as well.
	assert.False(t, f.getSource(srcA.ID).Dependents.InUse())
	resp = del(sourcePath(srcA.ID, ""), `{"request_key":"del-a"}`, f.withCSRF())
	require.Equal(t, http.StatusOK, resp.StatusCode)
	f.text(resp)
	require.NoError(t, jsonUnmarshal(f.text(f.do(http.MethodGet, "/admin/api/sources")), &list))
	assert.Empty(t, list.Sources)

	// The item routes keep their methods.
	resp = f.do(http.MethodPut, sourcePath(1, ""), f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
	assert.Equal(t, "GET, HEAD, PATCH, DELETE", resp.Header.Get("Allow"))
	_ = resp.Body.Close()
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminAPI_SourceSoldDirectlyCannotBeDeleted(t *testing.T) {
	f := newSourceAPIFixture(t)
	f.login()
	ctx := context.Background()

	src := f.mustCreateSource(f.createBody("Sold", ""))
	free, err := f.db.GetPlanByName(ctx, database.FreePlanName)
	require.NoError(t, err)
	sub := &database.Subscription{TelegramID: 939393, ClientID: "sold-client", SubscriptionID: "sold-sub",
		Status: string(database.SubscriptionStatusActive), PlanID: free.ID}
	require.NoError(t, f.db.CreateSubscription(ctx, sub, ""))
	require.NoError(t, f.db.GetDB().Model(&database.Subscription{}).Where("id = ?", sub.ID).UpdateColumn("provider_source_id", src.ID).Error)

	assert.Equal(t, database.SourceDependents{Builders: []database.DependentRef{}, Subscriptions: 1}, f.getSource(src.ID).Dependents)
	f.expectError(f.do(http.MethodDelete, sourcePath(src.ID, ""), f.withCSRF(), withJSON(`{"request_key":"sold-del"}`)),
		http.StatusConflict, "source_in_use")
	// The customer keeps the source the subscription was sold on.
	var stored database.Subscription
	require.NoError(t, f.db.GetDB().First(&stored, sub.ID).Error)
	require.NotNil(t, stored.ProviderSourceID)
	assert.Equal(t, src.ID, *stored.ProviderSourceID)
}
