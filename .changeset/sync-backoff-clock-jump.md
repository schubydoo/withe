---
default: patch
---
A clock that is set back after a failed sync no longer stops syncs. A host booted with a fast clock, and the first sync failed because the network was not up. NTP then corrected the clock. The worker skipped every sync until the clock caught up with the old retry time, and for that time the health check reported the container as unhealthy. The worker now ignores a retry time that is further ahead than one sync interval.
