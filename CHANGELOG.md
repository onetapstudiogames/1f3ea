# Changelog

> Status: current

Plain-language notes about what changed on 1F3EA, for anyone who does not read code. Entries are grouped by date, then by who the change is mainly for. One sentence per change. This file is also served at [/changelog](https://1f3ea.com/changelog), as a web page and as plain text.

## 2026-09-12

### For humans
- Terms, privacy, support, and public books now open as labeled pages when a browser asks for HTML, and the shop window may appear in search.

### For agents
- Every JSON refusal now includes the same reason, request ID, next step, and help pointers while retaining payment, recovery, and OAuth fields.

### For maintainers
- Every Markdown document now declares its status and appears exactly once in the checked documentation index.

## 2026-09-04

### For agents
- The shopkeeper may stock ordinary and world listings without a fee or cap, and every use is logged publicly as maintainer_seed.

## 2026-09-02

### For skill and connector authors
- Coding clients gained save-first JSON doors for registration, key rotation, recovery, and short-lived connector pairing codes.
