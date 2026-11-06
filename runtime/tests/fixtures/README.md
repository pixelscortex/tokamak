# Source-map acceptance fixtures

`mapped.ts` is an async feature with a typed request and an imported helper.
Its deliberate error is on **line 9**, after an await on line 8. The helper puts
multibyte Unicode before the generated error in the minified bundle. Bun retains
the CJK characters literally and escapes the emoji as surrogate escapes; both
the returned error message and the original TS location are asserted.

`first-token.ts` calls an intentionally missing global on **line 3, column 1**
during module initialization. Its minified ESM starts with a literal Unicode
identifier at byte zero. This tests startup-error source mapping at the first
token, independently of the errors thrown inside the async feature.

`startup.ts` uses the same missing Unicode global in an exported initializer at
**line 3, column 3**. Its minified ESM starts with `var n=初始化();`, placing the
identifier at byte six rather than byte zero. A separate test ensures fixing the
first token does not leave initializer source locations unmapped or incorrect.

`array-initializer.ts` references a missing ASCII global at **line 3, column 3**
inside an exported array. Its minified ESM starts with `var n=[x];`. For the
reported generated frame `tokamak-bundle.js:1:8`, zero-based candidate columns
7 and 8 map to **line 3, column 3** and **line 4, column 1**, respectively. Both
candidates are ASCII boundaries; Unicode-boundary filtering cannot disambiguate
them. The test independently checks those real map entries and requires an
explicitly ambiguous diagnostic containing the actual initializer's original
line and the retained generated frame. It does not mandate exact annotation
formatting or pretend a uniquely correct mapping can always be recovered.

Engine shorthand can discard position information that a source map alone
cannot reconstruct. These fixtures are evidence for their specific locations,
not a claim that every engine frame permits exact original-token recovery; no
impossible exactness assertion is imposed on other shorthand cases.

The checked-in JavaScript and Source Map v3 files were produced by **Bun 1.4.4**:

```sh
bun build runtime/tests/fixtures/mapped.ts --target=browser --format=esm --sourcemap=external --outdir=runtime/tests/fixtures
bun build runtime/tests/fixtures/mapped.ts --target=browser --format=esm --sourcemap=external --minify --entry-naming='[name].min.[ext]' --outdir=runtime/tests/fixtures
bun build runtime/tests/fixtures/first-token.ts --target=browser --format=esm --sourcemap=external --minify --outdir=runtime/tests/fixtures
bun build runtime/tests/fixtures/startup.ts --target=browser --format=esm --sourcemap=external --minify --outdir=runtime/tests/fixtures
bun build runtime/tests/fixtures/array-initializer.ts --target=browser --format=esm --sourcemap=external --minify --outdir=runtime/tests/fixtures
```

Run these from the repository root to regenerate. Do not hand-edit mappings or
adjust the expected throwing line to follow runtime output. Tests include the
checked-in output, so Cargo tests do not need Bun or a bundler installation.
