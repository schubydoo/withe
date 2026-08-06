## What this changes

## Why

Link the issue if there is one.

## How you tested it

Say what you ran and what you saw. If you added a fixture, say which state it captures.

## Checklist

- [ ] `npm test` passes offline
- [ ] `npm run lint` and `npx tsc --noEmit` pass
- [ ] No token, key, or real hostname is in the diff, including in fixtures
- [ ] Withe still only reads — this adds no write to Renovate or to a forge
- [ ] The adapter boundary holds: nothing in `src/app/` imports from `src/adapters/`
- [ ] UI changes meet WCAG 2.1 AA, and no status is conveyed by colour alone
- [ ] Docs updated if behavior or configuration changed
