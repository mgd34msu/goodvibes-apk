# GoodVibes Companion

React Native companion app for the GoodVibes TUI/daemon using the published `@pellux/goodvibes-sdk` package.

## What It Does

- stores the daemon URL and bearer token in secure storage
- authenticates with username/password or an existing shared bearer token
- loads control-plane, session, task, and approval snapshots over HTTP
- keeps a lightweight WebSocket realtime feed open while the app is foregrounded
- refreshes read models after important agent/task/control-plane events
- lets you review and act on pending approvals
- lets you inspect shared sessions and send follow-up messages

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

## Notes

- This app is a remote control-plane client. It does not run the GoodVibes runtime locally on the phone.
- The realtime feed uses the SDK's React Native WebSocket path.
- Approval actions and session follow-ups depend on the scopes granted by the token or login you use.

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
