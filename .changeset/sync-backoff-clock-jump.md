---
default: patch
---
A clock that is set back after a failed sync no longer stops syncs. When a host booted with a fast clock, the first sync failed because the network was not up, and NTP then corrected the clock, the worker skipped every sync until the clock caught up with the old retry time, and the health check reported the container as unhealthy for that long. The worker now ignores a retry time that is further ahead than one sync interval.
