# Vendored streams

`streams.js` is the unmodified `package/dist/polyfill.js` from the npm tarball
`https://registry.npmjs.org/web-streams-polyfill/-/web-streams-polyfill-4.5.1.tgz`.
`streams.LICENSE` is the package's MIT license. Version, size, integrity and the
reason for choosing this package are recorded in `packages/engine/WEB_APIS.md`.

To update, check the upstream release and compatibility, verify the registry's
tarball integrity, extract these two files, then repeat the QuickJS streaming,
backpressure, encoding and abort spike. No Node or Bun runtime is shipped.
