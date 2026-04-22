# GoodVibes Companion

React Native companion app for the GoodVibes TUI/daemon using the published `@pellux/goodvibes-sdk` package.

## Feature Highlights

- stores the daemon URL and bearer token in secure storage
- authenticates with username/password or an existing shared bearer token
- supports Android QR onboarding for daemon URL, credentials, and token payloads
- loads control-plane, task, session, approval, and provider snapshots over HTTP
- keeps a lightweight realtime feed open while the app is foregrounded
- lets you review and act on pending approvals
- lets you inspect shared sessions, read transcripts, and send replies or follow-ups
- lets you create companion-only remote chat sessions on the daemon
- surfaces provider catalog, current model selection, provider warnings, and model changes
- keeps an activity timeline of important app, provider, and session events

## Install A Release APK

GitHub Releases publishes an installable Android APK for each semver tag.

1. Open the latest release on GitHub.
2. Download `app-release.apk`.
3. Install it on an Android device that can reach your GoodVibes daemon over LAN or another reachable network.

This project does not currently publish an iOS build artifact.

## Main Areas

- `Overview`: connection health, current model, open sessions, and pending work
- `Models`: provider catalog, provider readiness, auth hints, and model switching
- `Sessions`: shared-session list, live transcript, pending inputs, replies, and follow-ups
- `Approvals`: pending approval queue with allow/deny actions
- `Tasks`: daemon task visibility from the control plane snapshot
- `Activity`: recent app, provider, and session events
- `Remote Chat`: companion-only chat sessions backed by the daemon

## Run

```bash
npm install
npm run start
```

Android:

```bash
npm run android
```

Use your machine's LAN URL when testing on a physical phone, for example `http://192.168.1.24:3210`.

## Connect To The Daemon

The app can connect in two ways:

- `password`: store the daemon URL plus username/password, then sign in through the daemon
- `token`: store the daemon URL plus an existing bearer token

On Android, the QR scanner can import either mode directly from a QR payload.

## Notes

- This app is a remote control-plane client. It does not run the GoodVibes runtime locally on the phone.
- The realtime feed uses the SDK's React Native WebSocket path.
- Approval actions and session follow-ups depend on the scopes granted by the token or login you use.
- The phone must be able to reach the daemon URL directly. Most local setups use a LAN address.

## Typecheck

```bash
npm run typecheck
```

## CI

GitHub Actions runs `npm run typecheck` and `./gradlew assembleDebug` on pushes to `main` and on pull requests.

The CI workflow also uploads the debug APK as a workflow artifact.

## Releases

Push a semver tag such as `v1.0.0` to trigger the release workflow. It builds `android/app/build/outputs/apk/release/app-release.apk`, uploads it as a workflow artifact, and attaches it to the GitHub release for that tag.

Tagged releases now generate their public release page automatically.

- If `docs/releases/<tag>.md` exists, the workflow uses it for that specific release.
- Otherwise it falls back to `docs/releases/_default.md`.
- GitHub's generated changelog is appended automatically.

By default the release workflow falls back to debug signing so the APK remains directly installable for testing. To produce a properly signed release APK, configure these GitHub Actions secrets:

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_KEYSTORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

## QR Onboarding

On Android, the sign-in screen can scan a QR code and import:

- `baseUrl`
- `username`
- `password`
- `token`
- `authMode`

Accepted payload shapes:

```json
{"baseUrl":"http://192.168.1.24:3210","username":"operator","password":"secret","authMode":"password"}
```

```json
{"baseUrl":"http://192.168.1.24:3210","token":"gvb_xxx","authMode":"token"}
```

```text
goodvibes://connect?baseUrl=http%3A%2F%2F192.168.1.24%3A3210&username=operator&password=secret
```

```text
goodvibes://connect?baseUrl=http%3A%2F%2F192.168.1.24%3A3210&token=gvb_xxx
```
