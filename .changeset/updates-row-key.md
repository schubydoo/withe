---
default: patch
---

The pending-updates page now gives every row its own React key. It keyed a row by the repository and the target version alone, so one repository that holds the same dependency at two current versions produced two rows with one key. Both rows still render, and a shared key is still wrong: React reconciles a list by its keys, so a duplicate lets it treat one row as the other. The rows now carry the key the history page already uses, which names every field the store keeps the rows apart by.
