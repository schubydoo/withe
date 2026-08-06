# Security Policy

## Supported versions

Withe has not had a release yet. Once it does, only the latest release receives
security fixes.

| Version | Supported |
| --- | --- |
| latest | yes |
| everything else | no |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/schubydoo/withe/security/advisories/new) of
this repository and open a draft advisory. Only the maintainer can see it.

If private reporting is unavailable to you, open a public issue that says only
that you have a security report and asks for a private channel. Put no details
in it.

### What to include

- The type of vulnerability.
- The affected file paths, and the tag, branch, or commit.
- Steps to reproduce.
- Proof-of-concept code, if you have it.
- What an attacker gains.

### What to expect

Withe is maintained by one person in their spare time. Expect an
acknowledgement within **7 days** and no fixed schedule after that. You will be
told when the issue is fixed, and credited in the advisory unless you ask not
to be.

## What Withe holds

Withe reads a Renovate installation you already run. Two facts shape its threat
model:

1. **Withe holds a Renovate CE API bearer token.** That token is admin-scoped;
   Renovate CE issues no read-only credential. Anyone who reaches Withe's
   configuration or its process environment reaches your Renovate server.
2. **Withe stores Renovate job logs**, which can contain repository names,
   dependency versions, and whatever your runs printed.

Report anything that exposes either one — a token appearing in a log line, an
HTTP response, an error page, or a crash dump — as a vulnerability.

## Handling secrets in contributions

- Never commit a token, key, or credential, including in a test fixture.
- Scrub recorded CE fixtures before committing them. `CONTRIBUTING.md` explains
  how.
- Read configuration from the environment or a mounted file, never from a
  literal in the source.
