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

## Limits of the evidence

- Runtime mocks and real local HTTP tests do not simulate every provider or production crash.
- Observed routing evidence comes from DSH request headers, not independent provider billing records.
- PTC availability depends on the installed DSH runtime and preset composition.
- Normal application restart was tested for the predecessor deployment; whole-machine reboot, every model/effort combination and long-running workloads were not exhaustively tested.
- No credentials, live receipts or private infrastructure configuration are required to run the automated suite.
