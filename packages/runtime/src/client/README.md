# Client connection

The native runtime owns this bounded WebSocket adapter. It never owns backend
execution or storage. Its canonical-schema parity checks use server types only
in tests, not in the normal client dependency graph.
