# Alfred 5.0 Implementation Guide

This step-by-step playbook outlines how to recreate the Alfred 5.0 personal finance platform from an empty Google Apps Script project and companion Google Sheet. Each stage lists the expected artifacts, validation steps, and safety checks so teams can onboard quickly while preserving auditability, reliability, and security expectations.

## 1. Prepare the Workspace
1. **Clone the repository** and install Node.js 18+ and clasp if you plan to push changes to Apps Script. `npm install` installs helper scripts used for audits and tests.
2. **Create the Google Sheet** that will serve as the primary datastore. Keep the share settings restricted to project collaborators.
3. **Open the Apps Script editor** bound to the sheet and enable the V8 runtime. Record the script ID for CI deployments.
4. **Configure Script Properties** with environment metadata:
   - `ALFRED_ENV` (`dev`, `stage`, or `prod`)
   - `ALFRED_BASE_CURRENCY`
   - `ALFRED_FEATURE_FLAGS` (JSON string, optional)
   - Secrets such as API keys for OCR or LLM providers.
5. **Copy the repository’s `apps-script` sources** into the Apps Script editor using clasp or manual paste. Preserve module filenames to keep namespace alignment.

## 2. Verify Schema & Bootstrap (Phase 0)
1. Run `Main.handleCommand('@migrate')` to execute `Mod_Schema.verifyAndMigrate`. This provisions all required sheets (`Transactions`, `Staging_Transactions`, `Import_Sessions`, `Categories`, etc.) and records the schema version.
2. Execute `Main.handleCommand('@diagnostics')` to confirm environment detection, logging, metrics, heartbeat, and cache/lock services via `Mod_Platform`.
3. Review the `_Logs` and `_Metrics` sheets to ensure structured JSON rows are created. Fix any missing scopes or permission prompts before proceeding.

## 3. Configure Phase 1 Intake
1. Populate reference data (`Categories`, `Accounts`, `Payees`) if available.
2. Trigger `Main.handleCommand('@import')` with a payload containing sample transactions (use Apps Script execution logs to supply JSON). Verify dedupe behavior and the `Staging_Transactions` tab for normalized results.
3. Capture OCR or CSV imports by implementing source adapters in `Mod_Intake.sources` and confirm each session is recorded in `Import_Sessions`.

## 4. Enable Categorization (Phase 2)
1. Define rules in the `Rules` sheet using priority, pattern, scope, and action columns.
2. Run `Main.handleCommand('@categorize')` in dry-run mode to inspect log output without mutating staging rows.
3. Review `Mod_Categorize` metrics for match rates, confidence scores, and review queues.

## 5. Commit Transactions (Phase 3)
1. After categorization, call `Main.handleCommand('@sync')`. This promotes `READY_SYNC` staging rows into the `Transactions` ledger with fingerprints and audit metadata.
2. Validate duplicate detection by re-running the command—no additional rows should be appended when fingerprints already exist.
3. Use the `_ChangeLog` (if enabled) to confirm before/after snapshots.

## 6. Reconcile Statements (Phase 4)
1. Upload or generate statements in the `Statements` tab (one row per account/period) or connect to intake adapters that populate it.
2. Invoke `Main.handleCommand('@reconcile')` with statement metadata. The module writes matches to `Statement_Matches` and unresolved items to `Statement_Exceptions`.
3. Inspect reconciliation metrics for unmatched totals and review the exceptions queue.

## 7. Analytics & Forecasts (Phase 5)
1. Run `Main.handleCommand('@analytics')` to compute runway, burn rate, envelopes, and anomaly flags. Outputs persist to `_Analytics` and are accessible via `Mod_Dashboard.getDashboardPayload`.
2. Confirm debt-free forecasts and investment performance data are emitted for UI consumption.
3. Benchmark runtimes by reviewing metrics latency entries; adjust batch sizes or caching as needed.

## 8. Debt Planning (Phase 6)
1. Populate the `Debts` sheet with balances, rates, and minimum payments.
2. Execute `Main.handleCommand('@debt')` to generate amortization schedules in `Debt_Amortization` and payoff strategies in `Debt_Strategy`.
3. Review logs for snowball/avalanche comparisons and confirm dry-run mode works before committing data.

## 9. Investment Tracking (Phase 7)
1. Ensure `NetWorthAssets` and `FXRates` sheets contain baseline holdings and currency data.
2. Run `Main.handleCommand('@invest')` or schedule triggers to update holdings, allocation variances, and net-worth history via `Mod_Invest.refreshPortfolio`.
3. Inspect health probes (`Mod_Health.checkInvest`) and analytics integration for portfolio summaries.

## 10. Security & Privacy Hardening (Cross-Cutting)
1. Use `Main.handleCommand('@security seed')` to create role and access sheets.
2. Assign collaborators to `Owner`, `Editor`, or `Viewer` roles in the `Security_Roles` tab.
3. Wrap new commands in `Mod_Security.enforceRole` checks and confirm logs redact PII using `Security.redactPII` helpers.
4. Store secrets exclusively in Script Properties and retrieve them through `Security.getSecret`.

## 11. Command Center UI (Phase 8)
1. Deploy the SPA by calling `Main.handleCommand('@ui')` and selecting **Deploy → Test deployments** in the Apps Script editor.
2. Verify the dashboard loads analytics payloads, respects viewer permissions, and surfaces command palette actions.
3. Expand UI modules incrementally, keeping complex logic in server-side modules for easier testing.

## 12. Performance & Observability Enhancements
1. Monitor metrics for latency spikes; leverage `Mod_Platform.chunkedProcess` and CacheService helpers to tune workloads.
2. Configure time-driven triggers with guardrails (e.g., 5-minute execution budgets) and use LockService wrappers to prevent overlap.
3. Keep the heartbeat sheet updated via `Mod_Health.publishHeartbeat` and investigate alerting hooks if failures accumulate.

## 13. Testing & CI/CD (Cross-Cutting)
1. Run `npm run lint`, `npm test`, and `npm run audit` locally to maintain code quality and dependency hygiene.
2. Maintain ≥90% coverage by adding gas-tap or Jest tests for each module. Coverage thresholds are enforced in CI.
3. Review GitHub Actions (`.github/workflows/ci.yml`) for lint, test, and audit stages; extend with additional gates as needed.

## 14. Documentation & Release (Phase 10)
1. Generate API documentation with `npx jsdoc apps-script -d docs/api`.
2. Update `README.md` and CHANGELOG entries to reflect new features or migrations.
3. Run a full smoke test in Apps Script (`@migrate`, `@diagnostics`, `@import`, `@sync`, `@analytics`, `@ui`).
4. Tag the release (e.g., `v1.0.0`) after successful validation and archive the deployment package for rollback.

## 15. Operational Runbooks
1. Maintain a runbook for recovery procedures referencing `Mod_Recovery.playbook(errorCode)` outputs.
2. Document onboarding steps for new banks or data sources, including mapping templates for CSV/OCR imports.
3. Schedule quarterly security reviews to rotate secrets, audit access roles, and review logs for anomalies.

Following this guide ensures teams can rehydrate the Alfred 5.0 platform, extend it safely, and operate it with high reliability and compliance.
