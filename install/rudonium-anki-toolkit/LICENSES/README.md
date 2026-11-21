# License records

The root [LICENSE](../LICENSE) contains the standard GPLv3 text. [NOTICE.md](../NOTICE.md) identifies the author of the Rudonium changes, the original project and its contributors. Component-specific notices and permissions remain applicable.

A successful build indexes the installed npm records in `dependencies/inventory.json`. The index maps each original path to its byte range and SHA-256 in `NOTICES.txt`, `PACKAGE-METADATA.txt`, or the optional `ORIGINALS.bin` for binary and non-UTF-8 records in the same directory. It also lists missing notices. This is an inclusive inventory of build and potential runtime dependencies, not a claim about the exact Rollup bundle or an automatic compatibility approval. Review missing notices, unknown license expressions and included assets before publishing a binary.

Original upstream files and their hashes are preserved separately under `UPSTREAM-SNAPSHOT` in the prepared source tree and distribution directory. Until a real build obtains those files and dependencies, this kit does not contain a completed upstream/dependency audit.
