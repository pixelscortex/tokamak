# Tokamak patches to rquickjs-sys 0.14.0

This directory is the published `rquickjs-sys` 0.14.0 crate, unpacked from
https://static.crates.io/crates/rquickjs-sys/rquickjs-sys-0.14.0.crate
(sha256 `cee271d0eeba64f0915b846cb7ae02e16faf3dfdffdca91731101d9d30fe3423`,
matching `Cargo.lock`), with the patch below applied. Nothing else differs.
The workspace `Cargo.toml` routes `rquickjs-sys` here via `[patch.crates-io]`.

## 1. Array.prototype.find* double free on interrupt (quickjs-ng 0.16.2)

**Bug.** `js_array_find` (backing `find`, `findIndex`, `findLast`,
`findLastIndex`) frees `val` at the end of each iteration but does not reset
it. quickjs-ng 0.16.2 added `js_poll_interrupts` at the top of the loop (PR
#1674). When Tokamak's deadline interrupt fires there, the `exception:` path
frees the previous element a second time. The owning array later frees the
dangling element and the process segfaults in `list_del` (seen as
EXC_BAD_ACCESS at 0x8 from `js_array_finalizer`).

**Impact.** Any JavaScript that hits its time budget inside a `find*` loop
crashes the whole process instead of failing with a clean deadline error:
server queries, mutations and actions, and desktop plugin UI alike.

**Fix.** Upstream quickjs-ng commit
[`e22ce4de4362`](https://github.com/quickjs-ng/quickjs/commit/e22ce4de4362)
(2026-11-02, "Clear Array.find value ownership after release (#1826)"):

```diff
@@ js_array_find
         JS_FreeValue(ctx, val);
+        val = JS_UNDEFINED;
         JS_FreeValue(ctx, index_val);
```

**Remove when** a released `rquickjs-sys` bundles a quickjs-ng that contains
`e22ce4de`. Then delete this directory and the `[patch.crates-io]` entry.
