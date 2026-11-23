import path from "tokamak:path";

export * from "tokamak:path";

// LLRT defines these on the default object but leaves the named exports unset.
export const { sep, delimiter } = path;
export default { ...path, sep, delimiter };
