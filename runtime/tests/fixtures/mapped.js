// runtime/tests/fixtures/describe.ts
function describe(id) {
  return `作業 \uD83E\uDDEA ${id}`;
}

// runtime/tests/fixtures/mapped.ts
async function invoke(request) {
  const label = describe(request.id);
  await Promise.resolve(label);
  throw new Error(`missing todo: ${label}`);
}
export {
  invoke
};

//# debugId=5559B7E6D3B1C8CB64756E2164756E21
