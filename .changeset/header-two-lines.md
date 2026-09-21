---
default: patch
---

The dashboard header now uses two lines. The first line holds the page links: all repositories, completed updates, log problems, and Renovate health. The second line holds the fleet's numbers: repositories, pending updates, lock-file refreshes, and the countdown to the next Renovate run. Before, all of these shared one line, so a count and a page link looked alike. The page links are now in a `nav` landmark named "Pages", so a screen reader can jump to them. A count of one now uses the singular, for example "1 repository" and "1 lock-file refresh". When the countdown goes blank in an open tab, the line no longer ends with a stray "·".
