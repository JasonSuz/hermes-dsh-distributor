# Verification

## Automated checks

```sh
npm test
npm run check
npm pack --dry-run
```

Tests cover exact provider/model/effort selection, standard/PTC tool presentation, actual request-header validation, unsupported-route rejection, explicit `none`, isolated sessions, scoped plugin unload/reload, workspace and symlink admission, bearer authentication, MCP metadata, body limits and timeout, cancellation, deadlines, concurrent duplicate requests, disk-write ambiguity, restart interruption, and exclusive state ownership.

The public package additionally checks that its package name, Cordis ID, exported name, health response and MCP server identity agree on `hermes-dsh-distributor`.

## Prior implementation evidence

The implementation before its public package rename was tested with real Claude and Codex subscription providers, including standard and PTC modes. Real Hermes CLI → persistent gateway → private MCP → DSH execution → result retrieval also completed. Existing receipts remained readable following normal DSH application restart and automatic tunnel-port rediscovery. Deployment addresses, account-specific provider IDs, session IDs and task receipts are deliberately excluded from this public repository.

These earlier live results establish the inherited implementation behavior, not a fresh live deployment of the renamed public package. The renamed package's local tests and packaging must pass separately. Installing or migrating a running deployment is a separate operator action.

## Limits of the evidence

- Runtime mocks and real local HTTP tests do not simulate every provider or production crash.
- Observed routing evidence comes from DSH request headers, not independent provider billing records.
- PTC availability depends on the installed DSH runtime and preset composition.
- Normal application restart was tested for the predecessor deployment; whole-machine reboot, every model/effort combination and long-running workloads were not exhaustively tested.
- No credentials, live receipts or private infrastructure configuration are required to run the automated suite.
