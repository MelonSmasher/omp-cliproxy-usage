# omp-cliproxy-usage

An [omp](https://omp.sh) plugin for models served through
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA). It adds:

- **Real cost in omp's own accounting.** Models on your CPA provider get
  per-token rates, so the status line `cost`, session stats, and `omp models`
  show API-equivalent cost instead of `$0`.
- **Subscription quota.** The 5-hour / weekly windows of the upstream
  credentials behind CPA appear in `omp usage`, in omp's native usage status,
  and in the plugin's own status text and widget.
- **Optional reconciliation.** What CPA recorded for each request of the
  session, shown next to omp's estimate.

Rates and quota come from the companion CPA plugin
[`cliproxy-costs`](https://github.com/MelonSmasher/cliproxy-costs), which must
be installed on the CPA side.

## Requirements

- omp 18.4.4 (other versions run with one warning; see [Verifying](#verifying))
- Bun ≥ 1.3.14 (bundled with omp)
- A CPA running `cliproxy-costs`, and that CPA's management key
  (`remote-management.secret-key`); `cliproxy-costs` serves its data only
  under CPA's management API (`/v0/management/cliproxy-costs/v1/`)
- An omp provider in `models.yml` pointing at CPA, for example:

  ```yaml
  providers:
    cliproxy:
      baseUrl: http://localhost:8317/v1
      api: openai-completions
      apiKey: CLIPROXY_API_KEY        # env var holding your CPA client key
      authHeader: true
      discovery: { type: openai-models-list }
  ```

## Install

```sh
omp plugin install github:MelonSmasher/omp-cliproxy-usage#<tag>
# or from a local checkout
omp plugin install /path/to/omp-cliproxy-usage
```

## Configure

```sh
omp plugin config set omp-cliproxy-usage provider cliproxy
omp plugin config set omp-cliproxy-usage apiKeyEnv CLIPROXY_API_KEY
# only when CPA's root is not the provider base URL minus /v1:
omp plugin config set omp-cliproxy-usage baseUrl https://cpa.example.com
```

The plugin authenticates to CPA with CPA's **management key**, taken **only**
from the environment and read again on every request:

```sh
export CLIPROXY_MANAGEMENT_KEY=<CPA's management key>
```

When CPA runs on another host, CPA must also allow remote management
(`management.allow-remote: true` in CPA's `config.yaml`; `remote-management.allow-remote`
in pre-v8 configs); otherwise it
answers `403` to every request from omp.

Never store the key with `omp plugin config set`. omp keeps plugin settings in
plain text (`omp-plugins.lock.json`, `plugin-overrides.json`), and there is no
omp secret store. The plugin declares no key setting, and it never writes the
key to settings, logs, session files, snapshots or usage reports.

**Wrong keys and CPA's IP block.** CPA blocks a client IP for about 30 minutes
after 5 wrong management keys, and every further attempt with a wrong key
extends the block. So after the first `401` or `403` the plugin sends **no
further request** to CPA (rates, quota, fx, request lookups, the refresh timer,
`/cliproxy-usage refresh`) and logs one warning. Until the key is accepted
once, requests go out one at a time, so one wrong key costs one attempt.
Rates keep coming from the local snapshot or the pricing feed, and the last
cached quota stays visible, marked stale. Fix the key (or wait out the block),
then restart omp; the stop lasts for the life of the omp process, which is
also the only time the environment variable can change.

### Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `cliproxy` | omp provider id (the `models.yml` provider that points at CPA) |
| `baseUrl` | provider base URL without a trailing `/v1` | CPA root URL |
| `managementKeyEnv` | `CLIPROXY_MANAGEMENT_KEY` | Name of the env var holding CPA's management key |
| `apiKeyEnv` | — (**required**) | Name of the env var holding the provider's inference key, the same value as `apiKey` in `models.yml` |
| `rates` | `cpa` | `cpa` (with snapshot/feed fallback), `feed` (public feed only), `off` |
| `feedUrl` | `https://catalog.stencil.so/models.json.zstd` | Pricing feed used as the last fallback |
| `aliases` | `{}` | JSON object `{"<model id>": "<catalog provider>/<catalog model>"}` for the feed fallback |
| `reconcile` | `false` | Look up CPA's recorded cost per request |
| `display` | `status` | `status`, `widget`, `both`, `off` |
| `staleAfterMinutes` | `30` | Quota observations older than this are shown as stale |
| `refreshSeconds` | `60` | Status/widget refresh interval (min 15) |
| `startupTimeoutMs` | `1500` | Longest wait for rates at startup (100–10000) |
| `driftWarnPct` | `10` | Warn once per session when omp and CPA disagree by more than this |
| `currency` | — (CPA's display currency) | ISO 4217 code (`EUR`, `CNY`, …) for the plugin's status, widget and report; see [Currency](#currency) |

Invalid values fall back to the default with one warning.

**Why `apiKeyEnv` is required.** omp only lets an extension set rates by
re-registering the provider's models, and that call needs the provider's key
reference. `omp usage` also probes a custom usage provider only when that same
registration carries a key reference. The plugin passes the env var **name**
through unchanged. It never reads or stores the key itself. When `apiKeyEnv` is
unset, rates and quota stay off and the plugin logs one warning.

### Status line

The plugin sets a status entry with the key `cliproxy`. omp renders plugin
statuses in the `status` segment, so `statusLine.rightSegments` (or
`leftSegments`) must include `status`. The plugin never changes your
status-line configuration.

Example: `Codex 5h 42% · 7d 17% | Claude 5h 81% (stale) | $? | cpa €1.62 (Δ +3%, ECB rate 2026-09-30)`

- one group per upstream family, showing the busiest credential for each window
- `(stale)`: the newest observation is older than `staleAfterMinutes`, or CPA is unreachable
- `$?`: at least one model on the provider has no rate (its cost stays 0)
- `cpa X (Δ …)`: only with `reconcile`; shows `cpa pending` until CPA has recorded the first request. Outside USD it also names the rate date

`display: widget` or `both` adds a widget below the editor (at most 10 lines)
with one bar per credential × window and a countdown to each reset. With
`reconcile`, its last line is the session cost (omp and CPA) in the display
currency with the rate date.

### Command

`/cliproxy-usage` shows every window with its absolute reset time, the
session's cost per model (omp vs CPA), the rate cards in use, unpriced models,
and recent errors. `/cliproxy-usage refresh` also discards omp's cached usage
report, re-fetches rates and quota, and re-registers the provider when rates
changed.

## Currency

Everything is computed and stored in USD. The plugin's own status text, widget
and `/cliproxy-usage` report convert USD amounts for display only, at the
latest rate from `cliproxy-costs` `fx` (ECB reference rates by default):

- currency: the `currency` setting, else the CPA's `display_currency`, else USD
- format: `cpa €1.62`, `cpa ¥12.34` (`Intl.NumberFormat`, narrow symbol)
- every converted amount is labelled with its source, e.g. `ECB rate 2026-09-30`;
  `stale` / `error` follow the CPA's feed status, `cached` means CPA is
  unreachable and the last fetched rates (`fx.json` snapshot) are used
- the report shows the USD amount next to each converted one
- a currency without a rate falls back to USD, with one warning and a note in
  the report; it is never shown at a rate of 1

Rates are fetched with the quota (at most every 15 minutes; `/cliproxy-usage
refresh` always re-fetches). With `currency: USD` the plugin never calls `fx`.

Two things stay USD, because omp has no currency support:

- omp's native `cost` status segment and session stats
- the rates registered with omp (`registerProvider` model `cost`); they are
  the USD rate cards, unconverted, so omp's estimate stays comparable with
  CPA's ledger

## How pricing works

omp has no API for changing just the cost of a model. `registerProvider` with
`models` **replaces** the provider's roster. So in the extension factory, which
`omp models`, `omp usage`, interactive sessions and RPC mode all run, the
plugin:

1. reads the provider's current models through a throwaway registry, with
   extended context forced off so the standard windows are copied;
2. fetches rates in this order: `cliproxy-costs` `rates` (the same numbers CPA
   uses) → the last good local snapshot → the public pricing feed (exact id in
   anthropic/openai/google, or your `aliases`). Unknown models are never
   priced by guess;
3. re-registers every model with its public fields copied and only `cost`
   replaced. A context tier becomes omp's `cost.longContext`; omp supports one
   tier, so the lowest is used. It applies when prompt tokens exceed the
   threshold, same as `cliproxy-costs`.

Verified on omp 18.4.4:

| Field | After re-registration |
| --- | --- |
| `name`, `api`, `baseUrl`, `reasoning`, `thinking`, `input`, `contextWindow`, `maxTokens`, `headers` / auth header, API key resolution | preserved (copied) |
| `compat` | preserved (copied from `compatConfig`) |
| `supportsTools` | preserved (copied; omitting it turns unset into `false`) |
| `models.yml` `modelOverrides`, including `maxContextWindow` and extended context | preserved (omp re-applies them after the runtime overlay) |
| `cost.longContext` | carried through runtime registration |
| `cost` | replaced; unknown models keep their existing cost |

Other points:

- A model that appears later (new discovery) stays listed but unpriced until
  the next re-registration: session start, the refresh timer, or
  `/cliproxy-usage refresh`.
- If the roster read returns no models, the plugin registers nothing, so a
  failed read never replaces a working roster.
- At startup the plugin waits at most `startupTimeoutMs` for rates. If CPA is
  down, it prices from the snapshot; with no snapshot and no feed, only quota is
  registered.
- On session start, the session's active model is re-bound to the priced
  registry entry, because omp selects the startup model before extension
  registrations apply.

omp's cost remains an **estimate** built from its own token counts and these
rates. CPA's ledger is the reference; turn on `reconcile` to compare the two.

## Quota

The plugin registers an omp usage provider in the same call. `fetchUsage` reads
`cliproxy-costs` `quota` and maps each credential × window to one limit:

- `id` is `<credential>:<window id>`
- `scope` is `{provider, accountId: credential, windowId, tier: family}`
- `amount` is `{used, limit: 100, unit: "percent", usedFraction}`; `usedFraction` is always set
- `window` carries `durationMs` and `resetsAt`

Status follows CPA; observations older than `staleAfterMinutes` become
`unknown` with a `Stale` note. Values are passive observations of the most
recent responses that went through CPA, not live polls. When CPA is
unreachable, the last cached copy is served, marked stale.

omp's native usage status shows only one group for the active provider. The
plugin's status text and widget show all credentials.

## Reconciliation (`reconcile: true`)

CPA returns `X-Cpa-Trace-Id` on every response, and only CPA sets it. The
plugin records these trace ids as custom session entries, so they survive
resume. After each agent run it looks them up in batches through
`cliproxy-costs` `requests`. Traces that are still pending are retried for up
to 10 minutes and never counted as zero. When omp's estimate and CPA's recorded
cost differ by more than `driftWarnPct`, the plugin notifies once per session.
Session entries contain trace ids only.

## Verifying

```sh
# roster: only cost may differ
omp models <provider> --json --no-extensions > before.json
omp models <provider> --json --no-extensions -e /path/to/omp-cliproxy-usage/src/extension.ts > after.json

# quota
omp usage --json --provider <provider>

# deep compare of every Model field (lazy + full snapshot, extended context off/on)
SPIKE_PROVIDER=<provider> SPIKE_APIKEY_ENV=<key env var name> \
  omp models <provider> --json --no-extensions -e /path/to/omp-cliproxy-usage/scripts/spike-preserve.ts > /dev/null
```

`spike-preserve.ts` prints a JSON summary to stderr. Every `diffs` object
should be empty. Run it after upgrading omp.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `setting "apiKeyEnv" is unset` | Set `apiKeyEnv` to the env var name used as `apiKey` in `models.yml` |
| `management key env var … is not set` | Export the variable named by `managementKeyEnv` before starting omp |
| `management key rejected (401)` | The key differs from CPA's `management.secret-key` (`remote-management.secret-key` in pre-v8 configs). The plugin stopped calling CPA; fix the key and restart omp |
| `CPA refused management access (403)` | CPA blocked this IP after repeated wrong keys (about 30 minutes; each retry extends it), or CPA is remote without `management.allow-remote: true`. The plugin stopped calling CPA; fix the cause and restart omp |
| `route not found (404)` | `cliproxy-costs` is not loaded in that CPA (or predates the management routes), or `baseUrl` is wrong |
| `provider "…" has no models` | Wrong `provider` id, or discovery has not run yet (start omp once online) |
| No quota in the status line | `status` is missing from `statusLine.*Segments`, or `display` is `widget`/`off` |
| `$?` in the status | Some models have no rate; `/cliproxy-usage` lists them |
| `no EUR rate from cliproxy-costs; showing USD` | The CPA's `currency.currencies` lacks that code, or its FX source has no rate for it |
| `cliproxy-costs fx: route not found (404)` | `cliproxy-costs` on the CPA predates `fx`; amounts stay USD |

Plugin data (rate/quota/exchange-rate snapshots and the feed cache) lives in
`<omp agent dir>/plugins-data/omp-cliproxy-usage/`. The files have mode 0600
and contain no secrets.

## Development

```sh
bun install
bunx tsc --noEmit
bun test
```

Tests run against the pinned omp packages (devDependencies) with a throwaway
agent directory (`test/preload.ts`) and a mock of CPA's management API serving
the `cliproxy-costs` routes (`test/fixtures/cpa-mock.ts`, built from the
vendored contract examples in `test/fixtures/contract/`). You can also run the
mock on its own: `MOCK_KEY=<32+ chars> bun test/fixtures/cpa-mock.ts`.

## License

[MIT](LICENSE) © Alex Markessinis.
