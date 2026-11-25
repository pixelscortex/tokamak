// The native host supplies the only operations available to this adapter.
export async function run({ args }, host) {
  const { before, after, needsShape } = host.op("hook.stages", args);
  for (let i = 0; i < before.length; i++) {
    args = await host.op("hook.before", { index: before[i], args });
  }

  const original = await host.op("hook.target", args);
  let result = original;
  for (let i = 0; i < after.length; i++) {
    result = await host.op("hook.after", {
      index: after[i],
      args,
      result,
      original: needsShape ? original : null,
    });
  }
  return result;
}
