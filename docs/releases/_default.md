# GoodVibes Companion

Android companion app for the GoodVibes daemon.

## Highlights

- Secure daemon sign-in with either username/password or bearer-token auth
- Android QR onboarding for importing daemon connection details quickly
- Companion-only remote chat sessions backed by the daemon
- Shared-session browsing with transcript viewing, replies, and follow-up messages
- Approval queue review with mobile allow and deny actions
- Provider and model visibility, including current-model switching when the daemon allows it
- Realtime foreground updates and a recent-activity timeline for important daemon events

## Setup

You will need:

- a running GoodVibes daemon
- a reachable daemon URL such as `http://192.168.x.x:3210`
- either daemon username/password credentials or a bearer token with the scopes you want to use

## Notes

- This app is a remote client; it does not run the GoodVibes runtime locally on the phone
- The phone must be able to reach the daemon URL directly
- QR scanning is available on Android builds
