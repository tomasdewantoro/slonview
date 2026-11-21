# Releasing Slonview

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a tag matching `v*`
is pushed. Every build lands in a **draft** GitHub Release, so nothing is public until you
publish it.

| Platform | Runner | Target | Bundles |
|---|---|---|---|
| macOS, Apple Silicon | `macos-latest` | `aarch64-apple-darwin` | `.app` (tarball), `.dmg` |
| macOS, Intel | `macos-latest` | `x86_64-apple-darwin` | `.app` (tarball), `.dmg` |
| Linux x86_64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb` |
| Windows x86_64 | `windows-latest` | `x86_64-pc-windows-msvc` | `.msi`, NSIS `-setup.exe` |

Linux builds on Ubuntu 22.04 on purpose: the AppImage and deb link against the runner's glibc,
so an older base runs on more distributions.

## Cutting a release

1. Bump the version in `Cargo.toml` (`[workspace.package] version`), `src-tauri/tauri.conf.json`
   (`version`) and `package.json` (`version`), and commit.
2. Make sure CI is green on `main`.
3. Tag and push:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. Wait for the four `Release` jobs. Open the draft release, check that every asset is attached
   (2 × dmg, 2 × app tarball, AppImage, deb, msi, setup.exe), edit the notes, and publish.

To retry a failed job, re-run it from the Actions tab; tauri-action uploads into the existing
draft for the same tag.

## Unsigned builds

Without signing secrets, artifacts are unsigned. This repository has the macOS secrets set, so
only the Windows builds are unsigned today:

- **macOS:** Gatekeeper blocks the first launch. Right-click the app and choose **Open**, or run
  `xattr -dr com.apple.quarantine /Applications/Slonview.app`.
- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info**, then
  **Run anyway**.
- **Linux:** AppImage and deb are not signed on any distribution by default; nothing to do.

## Signing and notarization

Each signing step in `release.yml` runs only when its secrets exist, so adding secrets is all it
takes. Add them under **Settings → Secrets and variables → Actions → Repository secrets**.

### macOS code signing

Needs an Apple Developer Program membership and a **Developer ID Application** certificate.

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | The certificate and private key exported from Keychain Access as `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The identity name, e.g. `Developer ID Application: Your Name (TEAMID)`; list with `security find-identity -v -p codesigning` |

The Tauri CLI imports the certificate into a temporary keychain on the runner and signs the app.

### macOS notarization

Notarization runs only when signing is configured. Pick one of the two methods; if both are set,
Apple ID wins.

**Apple ID with an app-specific password**

| Secret | Value |
|---|---|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | An app-specific password from <https://account.apple.com> → Sign-In and Security |
| `APPLE_TEAM_ID` | Your 10-character team ID (Membership details in the developer portal) |

**App Store Connect API key**

| Secret | Value |
|---|---|
| `APPLE_API_KEY` | The full contents of the downloaded `AuthKey_<KEYID>.p8` file |
| `APPLE_API_KEY_ID` | The key ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the keys list in App Store Connect → Users and Access → Integrations |

The workflow writes the key to a temporary file and passes `APPLE_API_KEY`, `APPLE_API_ISSUER`
and `APPLE_API_KEY_PATH` to the Tauri CLI.

The Tauri CLI notarizes the `.app` but builds the `.dmg` afterwards, so the dmg itself would be
unnotarized and Gatekeeper would reject the download. The **Notarize and staple the dmg** step
submits the dmg with `notarytool`, staples the ticket, checks it with `spctl`, and replaces the
release asset.

### Windows code signing

Needs an Authenticode code-signing certificate as a `.pfx` file (an OV certificate on a file;
EV certificates on hardware tokens or cloud HSMs need a different signing command and are not
covered by this workflow).

| Secret / variable | Value |
|---|---|
| `WINDOWS_CERTIFICATE` (secret) | The `.pfx`, base64-encoded: `base64 -i cert.pfx` (macOS) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))` (PowerShell) |
| `WINDOWS_CERTIFICATE_PASSWORD` (secret) | The `.pfx` password |
| `WINDOWS_TIMESTAMP_URL` (repository *variable*, optional) | RFC 3161 timestamp server; defaults to `http://timestamp.digicert.com` |

The workflow imports the certificate into the runner's user certificate store and passes its
thumbprint to the bundler through a temporary `--config` file, so `tauri.conf.json` stays free of
machine-specific values. The exe, msi and NSIS installer are signed with SHA-256.

## Verifying a signed build

```bash
# macOS
codesign --verify --deep --strict --verbose=2 /Applications/Slonview.app
spctl --assess --type execute --verbose /Applications/Slonview.app
xcrun stapler validate Slonview_0.2.0_aarch64.dmg
```

```powershell
# Windows
Get-AuthenticodeSignature .\Slonview_0.2.0_x64-setup.exe
```

## Measuring a release

Two scripts in `scripts/` produce the numbers used in the README. Run them yourself; both are
local-only and send nothing anywhere.

- `scripts/measure-app.sh [/Applications/Slonview.app]` launches the installed app (it opens a
  window), reports time until the process is up and its memory settles, samples idle RSS every
  0.5 s for 10 s (median and peak, for the app process alone and including WebKit helper
  processes), then quits the app.
- `scripts/bench-remote.sh postgres://user@host/db schema.table [runs]` times a full-table CSV
  export with `psql \copy` and with Slonview's export engine (through the dev-only e2e bridge,
  built in release mode), both to `/dev/null`, and prints the PostgreSQL version, connection type
  (Unix socket / loopback / remote, TLS or not) and machine model. It only reads; the Slonview
  side uses a read-only session and a temporary profile that is deleted afterwards.
