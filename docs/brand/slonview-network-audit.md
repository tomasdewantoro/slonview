# Slonview network audit

Claim under test: **"No telemetry; the app makes no network connections except to the PostgreSQL servers you configure."**

Scope: shipped macOS release build (`pnpm tauri build`) of this repository (branch `main`). The source was read statically. No code was edited and no app window was launched.

## VERDICT: TRUE WITH CAVEATS

No code path in the shipped app opens a socket to anything except the host and port of a connection profile the user configured. Nothing in the app sends telemetry, analytics, crash reports, or update checks, and no third-party SDK does either. The caveats are about wording and build hygiene, not hidden traffic:

1. **DNS.** When a profile uses a hostname, the OS resolver performs a DNS lookup, which sends a packet to the user's DNS server. A strict reading of "no network connections except..." does not cover this.
2. **Build mode.** The guarantee holds only for artifacts built with the Tauri CLI (`pnpm tauri build`). A plain `cargo build --release -p slonview` compiles Tauri in *dev* mode, and that binary loads its UI from `http://localhost:1420` (loopback only, but it is a socket the claim does not mention). Release artifacts must come from `tauri build`.
3. **OS components** such as WebKit, Gatekeeper/notarization, and Keychain are outside the app's control. See section 4.

## 1. Rust side

### 1.1 Direct dependencies (what slonview itself links)

| Crate | Declared at | Network capability | Reachable? |
|---|---|---|---|
| `tokio-postgres` 0.7, `deadpool-postgres` 0.14, `tokio-postgres-rustls` 0.14 | `crates/core/Cargo.toml:16-18` | TCP or Unix socket to a PostgreSQL server | **Yes. This is the only intended network path.** Target is `profile.host`/`profile.port` (`crates/core/src/conn.rs:84-99`), and the connection is opened at `conn.rs:115` (`cfg.connect(tls())`) and in the pool (`build_pool`, same file). |
| `rustls` 0.23 (ring, no default features) | `crates/core/Cargo.toml:19` | None of its own. It is a TLS state machine only. | Used on the PG socket. Certificate verification is replaced by `EncryptOnlyVerifier` (`conn.rs:28-62`, installed at `conn.rs:66-75`), so the app does no OCSP, CRL, or AIA fetches. rustls never does those anyway. |
| `keyring` 3 (`apple-native`) | `crates/core/Cargo.toml:20` | None. It uses local Security.framework. | Yes, locally only (`crates/core/src/secrets.rs:22-47`). |
| `directories`, `toml`, `url`, `time`, `serde*`, `uuid`, `ts-rs`, `tracing`, `tracing-subscriber` | `crates/core/Cargo.toml`, `src-tauri/Cargo.toml` | None | `tracing-subscriber` writes to stderr only (`src-tauri/src/lib.rs:9-11`). Nothing is exported. |
| `tokio` (workspace features: `rt-multi-thread, macros, sync, time, fs, io-util`) | `Cargo.toml` (workspace deps) | `net` feature **not** enabled for the app | `tokio/net` is enabled only in `[dev-dependencies]` (`src-tauri/Cargo.toml:30-31`), for the e2e bridge example and tests. tokio-postgres turns it on transitively for its own PG sockets. |
| `tauri` 2.12.7, `features = []` | `src-tauri/Cargo.toml:23` | See 1.2 | |
| `tauri-plugin-clipboard-manager`, `tauri-plugin-dialog`, `tauri-plugin-window-state` | `src-tauri/Cargo.toml:24-26`, registered at `src-tauri/src/lib.rs:14-16` | None. They cover the native pasteboard, `rfd` / NSSavePanel / NSAlert, and a local window-geometry file. | Yes, all local. |

A grep of `crates/core/src` and `src-tauri/src` for `std::net`, `tokio::net`, `lookup_host`, `Command::new`, `reqwest`, and `http` returns **no matches**. The app code opens no sockets itself and spawns no processes.

The core opens two other PG connections, both to the **same configured server**:
- Query cancel: `crates/core/src/engine.rs:227` (`cancel_query(conn::tls())`) opens a short-lived connection to the same host/port, which is the standard PostgreSQL cancel protocol.
- `test_connection` / `connect` reuse `open_client` (`conn.rs`). With `sslmode=prefer`, a failed TLS handshake is retried in plaintext against the same host.

`connurl.rs:12` defines the placeholder host `slonview-empty-host.invalid`. It is only a parsing stand-in and is mapped back to an empty host at `connurl.rs:42`, so it is never dialed.

### 1.2 Network-capable crates in `Cargo.lock` that are NOT reachable

| Crate | Pulled in by | Why it is not reachable on macOS release |
|---|---|---|
| `reqwest` 0.13.5, `hyper` 1.12, `hyper-util`, `tower-http` | `tauri` (`Cargo.lock:3973`) | In tauri 2.12.7, `reqwest` is a dependency only for `cfg(any(target_os = "android", all(target_vendor = "apple", not(target_os = "macos"))))`, i.e. Android and iOS (`~/.cargo/registry/.../tauri-2.12.7/Cargo.toml:316`). Even there it is used only under `#[cfg(all(dev, mobile))]` to proxy the dev server (`tauri-2.12.7/src/protocol/tauri.rs:32-80`). The local build cache of the (now removed) worktree confirmed it: `target/debug/build/` contained `tokio-postgres`, `socket2`, `mio`, `keyring`, `security-framework`, `tauri-plugin-fs`, and `muda`, but no `reqwest`, `hyper`, or `hyper-util`, so these are not compiled for this target. |
| `socket2`, `mio` | `tokio` / `tokio-postgres` | Socket primitives used only by the PG connection above. |
| `tauri-plugin-fs` | `tauri-plugin-dialog` (transitive) | Local filesystem only. It is not registered by slonview and no `fs:` permission is granted (`src-tauri/capabilities/default.json:6-14`). |
| `tray-icon`, `muda`, `tao`, `wry` | `tauri` | Native UI and webview hosting. No network code of their own. |

Crates **absent** from `Cargo.lock`: `ureq`, `isahc`, `curl`, `attohttpc`, `sentry*`, `opentelemetry*`, `posthog*`, `aptabase*`, `tauri-plugin-updater`, `tauri-plugin-http`, `tauri-plugin-shell`, `tauri-plugin-opener`, `tauri-plugin-deep-link`, `tungstenite`/`tokio-tungstenite`, `native-tls`/`openssl`, `hickory`/`trust-dns`, `rustls-native-certs`, `rustls-platform-verifier`, `webpki-roots`.

### 1.3 Tauri configuration

- `src-tauri/tauri.conf.json` has no `plugins` block, so there is no updater, no update endpoints, and no `createUpdaterArtifacts`. Updater: **not present at all**.
- `build.devUrl = "http://localhost:1420"` (`tauri.conf.json:8`). It is used only when tauri is compiled without the `custom-protocol` feature. tauri's `build.rs:252-255` sets `cfg(dev) = !custom_protocol`, and `tauri-2.12.7/src/manager/mod.rs:345-352` selects `dev_url` only under `cfg(dev)`. The Tauri CLI (`tauri build`) enables `tauri/custom-protocol`, so the release app serves the embedded `dist/` over `tauri://localhost` with no socket. **Caveat 2 above.**
- Capabilities (`src-tauri/capabilities/default.json:6-14`): `core:default`, clipboard read/write text, `dialog:allow-save|message|ask`, `window-state:default`. **No `http:`, `shell:`, `opener:`, `fs:`, or updater permissions.**

## 2. Frontend

### 2.1 Source (`src/**`, excluding generated `src/bindings`)

A grep for `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `http(s)://`, `window.open`, `href=`, and `<img` finds only:
- `src/dev/bridgeBackend.ts:10` with `const BRIDGE = "http://127.0.0.1:1499/invoke/"` and `:39` with `fetch(BRIDGE + cmd, …)`. This is dev-only (2.3).

Tauri APIs used in production code: `invoke` (`src/api.ts:3`), `writeText` (clipboard: `CellInspector.tsx:1`, `ResultGrid.tsx:17`), and `save`/`ask` (dialog: `TableTab.tsx:1`, `sql/ResultsPanel.tsx:3`, `sql/HistoryPanel.tsx:3`). All of them are IPC calls.

Styling: `src/index.css` uses system font stacks (`-apple-system`, `ui-monospace`, …). There is no `@font-face`, `@import url(...)`, or font CDN. `public/` and `src/assets/` are empty.

`index.html:5` references `/vite.svg` as the favicon. That file does not exist, so the request is a failed **local** `tauri://` request and causes no network traffic. Cosmetic fix: remove the line or add an icon.

### 2.2 Built bundle

The `dist/` currently in the main checkout is **stale**: its title is "Tauri + React + Typescript", it is 214 KB, and it contains no glide grid. `pnpm tauri build` regenerates it through `beforeBuildCommand`. The analysis below uses the fresh production build of identical source made in the former worktree (`dist/assets/index-B58foo9x.js` 1022 KB, `index-DkoZDmpk.css`, `data-grid-overlay-editor-*.js`, `number-overlay-editor-*.js`), grepped before that worktree was removed:

- **All `http(s)://` literals** are inert strings: XML namespaces (`www.w3.org/2000/svg`, `1998/Math/MathML`, `1999/xlink`), error-message URLs (`react.dev/errors/...`, `fb.me/use-check-prop-types`, `github.com/markedjs/marked`, `github.com/leandrowd/react-responsive-carousel/...`), and `data:image/svg+xml` URLs inside CodeMirror/glide themes. None of them is fetched.
- **`fetch(`** appears exactly once, in Vite's `modulepreload` polyfill, which fetches same-origin `<link rel=modulepreload>` hrefs (`/assets/...` over `tauri://`).
- **No** `WebSocket`, `XMLHttpRequest`, `EventSource`, `sendBeacon`, `127.0.0.1:1499`, `bridgeBackend`, `mockBackend`, font CDNs (`fonts.googleapis`, `gstatic`, `unpkg`, `jsdelivr`, `cdn.`), or analytics hosts (`google-analytics`, `googletagmanager`, `sentry`, `posthog`, `mixpanel`, `segment.io`). The only "amplitude" hit is the SVG attribute name `amplitude` in React's attribute table.
- The CSS bundle has no `url(`, `@import`, or `@font-face`.
- Third-party code bundled through `@glideapps/glide-data-grid` (peer dependencies `marked`, `lodash`, `react-responsive-carousel`; glide's `package.json` lines 60-64):
  - glide's `ImageWindowLoader.loadImage` sets `img.src = url` for **Image** cells, and its header-icon sprite loader uses `data:` SVG only. Slonview creates only `GridCellKind.Text` cells (`src/components/ResultGrid.tsx:233, 245`), so the image loader is never called with a URL. If it were, CSP `img-src 'self' data:` would block remote images.
  - `marked` (Markdown cells) and the carousel (image overlay editor) are bundled but unreachable because no Markdown or Image cells are created.
- CodeMirror and lucide-react: inline SVG and `data:` URIs only. No remote fetches.

### 2.3 Dev-only paths excluded from production

- `src/main.tsx:8-14` dynamically imports `./dev/mockBackend` / `./dev/bridgeBackend` only when `import.meta.env.VITE_MOCK === "1"` or `VITE_BRIDGE === "1"`. Vite substitutes these as build-time constants. In a production build without those env vars the branches are dead code and the chunks are not emitted. Confirmed by the grep above: `dist` contains no `127.0.0.1:1499`, `bridgeBackend`, `mockBackend`, `installMock`, or `VITE_BRIDGE`, and no extra chunk exists for them. The asset list is the main chunk plus glide's two overlay-editor chunks.
- `src-tauri/examples/e2e_bridge.rs` binds `127.0.0.1:1499` (`:24`, `:195`). Cargo examples are not part of the `slonview` binary or the `.app` bundle.
- `mockIPC` (`@tauri-apps/api/mocks`) is imported only by `src/dev/*` and `src/store/app.test.ts`, so it is not in the bundle.

### 2.4 CSP

`src-tauri/tauri.conf.json:24`:

```
default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost
```

- `connect-src` allows only Tauri IPC, which blocks fetch, XHR, WebSocket, EventSource, and beacon to any external origin.
- `default-src 'self'` covers `script-src`, `frame-src`, `media-src`, `object-src`, `worker-src`, and `manifest-src`, so no external origins are allowed there.
- `img-src` and `font-src` allow only `'self'` and `data:`.
- Tauri applies this CSP only in non-dev builds (`tauri-2.12.7/src/manager/mod.rs:357-360`, `fn csp`), which is exactly the release case.
- Gaps: `form-action` and `base-uri` do **not** fall back to `default-src`, and CSP does not restrict top-level navigation. The app renders no `<form action>`, `<base>`, or anchors built from data. All cell content goes into canvas Text cells or React text nodes, and there is no `dangerouslySetInnerHTML` or `marked` call in `src/`. So these gaps have no current exploit path. They are hardening items only.

## 3. Local-only side effects (no network)

- Profiles: `~/Library/Application Support/slonview/` (`crates/core/src/config.rs:13-16`).
- Passwords: login Keychain, service `slonview` (`crates/core/src/secrets.rs:5, 22-47`), through `keyring`'s `apple-native` backend (legacy keychain items, not iCloud-synchronizable). [INFERENCE: based on keyring 3 `apple-native` using the macOS legacy keychain API.]
- `.pgpass` import, CSV export through the native save dialog, and window-state file: all local filesystem.

## 4. OS-level / out of app scope

- **WKWebView / WebKit:** loads only `tauri://localhost` content. WebKit's own behaviour (for example Safe Browsing / fraudulent-site checks, which apply to http(s) navigations, or system WebKit updates) is Apple's and outside the app's control. [INFERENCE: no http(s) navigation occurs, so no Safe Browsing lookup should be triggered.]
- **Gatekeeper / notarization / XProtect:** macOS may contact Apple when an app is first launched. The build is currently not signed or notarized (README). This is OS behaviour, not app behaviour.
- **Keychain:** local Security.framework calls, not network.
- **DNS:** hostname resolution for configured PG hosts goes through the system resolver (caveat 1).

## 5. Empirical check

**Not performed.** This session had no shell or exec tool, so `cargo build --release`, `cargo run -p slonview --example e2e_bridge`, `nettop`, and `lsof` could not be run. To perform it:

1. `SLONVIEW_E2E_DIR=$(mktemp -d) cargo run -p slonview --example e2e_bridge &`
2. Send POST requests to `http://127.0.0.1:1499/invoke/<command>` (for example `parse_conn_url`, `save_profile`, `connect`, `fetch_page`, `run_sql`) against a local fixture database.
3. While those run: `lsof -nP -i -a -p <pid>` and/or `nettop -p <pid> -L 1`. The expected result is only the listener `127.0.0.1:1499`, the bridge clients, and `127.0.0.1:5432` or `/tmp/.s.PGSQL.5432`.
4. `kill <pid>`.

The bridge exercises the same `slonview_lib::ops` / `slonview_core::Engine` code the app uses, but not the Tauri shell or WebView. Sections 1.3 and 2 cover those statically.

## 6. Fixes recommended

1. **CSP hardening (optional, defence in depth):** append `; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` in `src-tauri/tauri.conf.json:24`.
2. **Release process:** build releases only with `pnpm tauri build`, never with bare `cargo build --release`. A dev-mode binary loads `http://localhost:1420`. Optionally add a CI check or a `[features] custom-protocol = ["tauri/custom-protocol"]` convention so the mode is explicit.
3. **Stale `dist/`** in the main checkout ("Tauri + React + Typescript"): harmless because `beforeBuildCommand` rebuilds it. Delete it or rebuild before any inspection of shipped assets.
4. **`index.html:5`:** remove the dangling `/vite.svg` favicon reference (cosmetic, local 404).
5. **Optional dependency diet:** glide-data-grid pulls `marked`, `lodash`, and `react-responsive-carousel` into the bundle as unused code. This has no network impact, only bundle size.

## 7. Safe wording to publish

> **No telemetry.** Slonview contains no analytics, crash reporting, or update checks. The only network connections it makes are to the PostgreSQL servers you configure (plus the DNS lookups needed to find them). Your passwords stay in your macOS Keychain.

Shorter variant:

> No telemetry. Slonview only talks to the PostgreSQL servers you configure.

Do **not** claim "makes no network requests at all": DNS and macOS's own Gatekeeper/WebKit behaviour would make that inaccurate.

## Runtime confirmation (orchestrator, 2026-11-21)

Ran the real engine headlessly (`e2e_bridge` example, same `slonview_lib::ops` code path as the app), connected a profile to `localhost:5432/slonview_fixture`, ran `select count(*) from orders`, then listed the process sockets with `lsof -nP -a -p <pid> -i`:

```
TCP 127.0.0.1:1499 (LISTEN)                      <- test bridge listener only, not in the app
TCP [::1]:53682->[::1]:5432 (ESTABLISHED)        <- PostgreSQL
```

No other sockets. Fresh `pnpm build` of `dist/`: no `1499`/`bridgeBackend`/`mockBackend`; the only URL strings are XML namespaces and error-message links (react.dev/errors, fb.me, github docs), none fetched.

Recommended fixes applied on main: CSP now also sets `object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`; removed the dead `/vite.svg` favicon link from `index.html`.
