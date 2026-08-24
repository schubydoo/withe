# Exposure & TLS

**Withe must not be published to the internet without authentication and TLS in front of it.** It is
read-only against Renovate, but it shows every repository, run, and log your Renovate can see, and by
default it has no password.

When Withe is reachable beyond loopback with no credentials set, it prints a warning at startup and
shows a banner on every page.

## Authentication

Set `WITHE_AUTH_USER` and `WITHE_AUTH_PASS`, and every page and route requires that credential.
Credentials are compared in constant time; repeated failures from one address are delayed. Only
`/api/health` answers without a login.

Basic auth is a floor, not a gate. Most operators running Renovate CE already run something better —
put Withe behind it:

- [Authelia](https://www.authelia.com/)
- [Authentik](https://goauthentik.io/)
- [Tailscale](https://tailscale.com/), so Withe is only reachable on your tailnet.

## Acknowledging the exposure

When you authenticate in front of Withe — a reverse proxy, an identity-aware gateway, a tailnet — the
port is not really open, but Withe cannot see that layer, so it still warns. Set
`WITHE_ACKNOWLEDGE_EXPOSURE=true` to silence the startup line and the banner.

The flag hides the message; it adds no protection. Use it only when access is controlled outside Withe.
If nothing sits in front, set `WITHE_AUTH_USER`/`WITHE_AUTH_PASS` or bind to loopback instead — those
close the port; this only quiets the warning about it.

## TLS

Set `WITHE_TLS_CERT` and `WITHE_TLS_KEY` to two mounted certificate files, and Withe terminates HTTPS
itself in a separate proxy process. It uses TLS 1.2 as a floor and 1.3 when the client offers it, and
sends no HSTS header — a homelab hostname is reused across services and a stray pin is hard to undo.

Withe neither obtains nor renews certificates. That is your reverse proxy or ACME client.

## The publish form is the real control

In a container, the bind address does not contain Withe — the published port does. The documented run
command uses `-p 127.0.0.1:8080:3000`, which publishes to host loopback only. Publishing as
`-p 8080:3000` puts the dashboard on your LAN with no password.
