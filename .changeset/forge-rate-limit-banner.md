---
default: minor
---

When the GitHub rate limit is low, Withe warns on every page. The health banner shown on each page now also carries this warning. It reads the forge headroom from the same /api/health poll, so no second poller is added. When headroom drops below 20%, an amber bar names how many requests are left and links to the health page.
