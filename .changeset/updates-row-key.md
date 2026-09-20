---
default: patch
---

The dashboard and the pending-updates page now give every update row its own React key. Each keyed a row by fields that left out the current version, so one repository that holds the same dependency at two current versions produced two rows with one key. Both rows still render, and a shared key is still wrong: React reconciles a list by its keys, so a duplicate lets it treat one row as the other. All three views now share the key the history page already used, which names every field the store keeps the rows apart by.
