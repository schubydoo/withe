---
default: patch
---
The sync worker now logs a `synced` line for each source on every cycle. It logged only the first cycle after start. The container log did not show the time of the last sync.
