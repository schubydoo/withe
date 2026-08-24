---
default: minor
---

Add WITHE_ACKNOWLEDGE_EXPOSURE to silence the no-password exposure warning for a deployment that controls access in front of Withe (a reverse proxy, an identity-aware gateway, a tailnet). It hides the startup line and the banner without setting credentials Withe would then also check; the warning itself keeps naming the real fixes rather than advertising the switch that hides it
