# Database migrations

The migrations are embedded into the binary (`migrations.go`) and applied at startup
with golang-migrate. The chain `001` … `051` is the **upgrade history** of the
database and must stay intact:

- an existing installation (for example at schema `50`) upgrades with the normal
  startup migration to the current schema;
- a fresh installation replays the same chain and ends with exactly the same schema
  (both paths are covered by `legacy_nodes_migration_test.go` and `migration_test.go`).

Migrations before `051` still create the tables of the removed VPN-panel subsystem
(`nodes`, `plan_nodes`, `subscription_nodes`, `plans.devices_limit`,
`plans.traffic_limit`, `subscriptions.traffic_reminders_sent`). That is history only:
`051_remove_legacy_nodes` drops them, and no code reads or writes them any more.
Do not edit or delete applied migrations — add a new numbered migration instead.

`051_remove_legacy_nodes.down.sql` recreates only empty legacy structures. To roll a
production database back, restore the database backup together with the previous
binary.
