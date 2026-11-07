# Verification

## Automated checks

```sh
npm test
npm run check
npm pack --dry-run
```

Tests cover exact provider/model/effort selection, standard/PTC tool presentation, actual request-header validation, unsupported-route rejection, explicit `none`, isolated sessions, scoped plugin unload/reload, workspace and symlink admission, bearer authentication, MCP metadata, body limits and timeout, cancellation, deadlines, concurrent duplicate requests, disk-write ambiguity, restart interruption, and exclusive state ownership.

The public package additionally checks that its package name, Cordis ID, exported name, health response and MCP server identity agree on `hermes-dsh-distributor`. Workspace tests cover native registration, title conflicts, canonical cwd admission, attachment-before-followup, attachment failure, cancellation, and receipt-write failure without model execution.

## Prior implementation evidence

The implementation before its public package rename was tested with real Claude and Codex subscription providers, including standard and PTC modes. Real Hermes CLI → persistent gateway → private MCP → DSH execution → result retrieval also completed. Existing receipts remained readable following normal DSH application restart and automatic tunnel-port rediscovery. Deployment addresses, account-specific provider IDs, session IDs and task receipts are deliberately excluded from this public repository.

These earlier results establish the inherited implementation behavior. Version 0.1.3 of the renamed package was subsequently installed and separately verified: 53 automated tests and syntax checks passed; a real private remote MCP request created and completed a Codex task in the configured existing Hermes workspace; native workspace membership was read back; another allowed cwd was rejected before execution; prior receipts stayed readable without replay. Health reported the renamed package identity and version, and the private tunnel's identity check was migrated accordingly. This new workspace check used direct authenticated MCP calls from the Hermes machine, not another classic Hermes CLI conversation.

## DSH 0.2.2-rc.1 executor repair (0.1.4)

The shipped host removed `tools.presentAs`. The adapter now uses scoped `tools.setExecutor` with the host's official NativeToolExecutor / PtcExecutor; a legacy API branch remains covered by mocks, not a promise of universal host-version support. Executor import/setup failures stop before followup and never downgrade the mode.

55 tests and syntax checks passed. The installed package's health reported 0.1.4. Two isolated local authenticated MCP smoke tasks completed using the real Codex Sol route with `high`: standard had native header evidence; PTC had run_code-only header evidence and a completed real run_code invocation. Both attached to the configured Hermes workspace. No business handoff task was replayed. These smoke calls validate the actual host module loader, not only injected executor fixtures. After reconnecting the existing private relay, authenticated direct MCP calls from the Hermes machine also read capabilities and both completed smoke receipts; the original failed business receipt remained failed and was not replayed. This remote readback was not a fresh Hermes CLI conversation or a persistent gateway inventory verification.

## Optional direct read access (0.1.5)

101 automated tests, syntax checks and package dry-run passed. Independent review found no additional blocking correctness/security issue. New coverage includes default-off discovery, explicit frozen workspace grants, global-memory grants, native metadata and live/cold transcript adapters, text-only projection, subagent exclusion, scope revocation during reads, signed pagination and stale IDs, copied-secret redaction before search, sanitized errors, bounded reads, strict dates, fixed memory paths, symlink/replacement checks and unrelated directory mutations. Synthetic integration verifies ten tools without creating agents or invoking a model.

The installed package reports 0.1.5 with read access enabled. Authenticated native calls list ten tools and the five explicitly granted current workspaces; a prior isolated smoke session was read from cold persistence over six transcript pages. Direct authenticated MCP calls from the Hermes machine exercised all six read tools, including summary-first memory search and a bounded read of an already-known user preference without printing its body. Ungranted workspace access, cross-workspace session access, cross-scope memory IDs and an invalid calendar date were rejected; missing bearer returned 401. The two completed smoke receipts and the original failed business receipt retained their previous status. No new model call, task replay, memory/session write or application/gateway restart was used.

Persistent gateway discovery was checked separately. Unchanged-config `reload.mcp` initially retained the old four-tool catalog; this Hermes version has no public single-service refresh RPC. Temporarily disabling only this target, reconciling its removal, restoring the original complete target configuration in `finally`, and reconciling its addition refreshed the actual gateway inventory to all ten tools. Final raw configuration matched the original exactly, permissions remained 0600, and all unrelated service status objects and tool inventories were unchanged. Service name, URL and token were preserved without restarting the gateway. This proves gateway discovery plus direct remote MCP reads, not a fresh model-driven Hermes conversation; no generic model-free gateway tool-invocation RPC was available in this version.

## Limits of the evidence

- Runtime mocks and real local HTTP tests do not simulate every provider or production crash.
- Observed routing evidence comes from DSH request headers, not independent provider billing records.
- PTC availability depends on the installed DSH runtime and preset composition.
- Normal application restart was tested for the predecessor deployment; whole-machine reboot, every model/effort combination and long-running workloads were not exhaustively tested.
- No credentials, live receipts or private infrastructure configuration are required to run the automated suite.
- Read access is not a credential-proof DLP system: prose can contain unknown secrets. System/reasoning/tool/header/attachment events are excluded, but copied text is only best-effort redacted.
- The native cold persistence API may decode a compressed log before the adapter's logical event bound is applied. Native metadata listing scales with the host catalog. Memory path guards do not provide a directory-fd guarantee against malicious same-user swap-and-restore races.
- Read configuration grants fixed current workspace IDs, not future workspaces. Archive files and subagents are excluded; all memory branches are included. Existing task execution remains a separate write-capable facility.
