import { expect, test } from "vitest";
import { compatibility } from "../src/host/compatibility";

test.each([
  ["tokamak@0.1.1", "fits"],
  ["tokamak@0.1.2", "fits"],
  ["tokamak@0.1.2+review.1", "fits"],
  ["tokamak@0.1.2-rc.1", "fits"],
  ["tokamak@0.1.3-rc.1+review.1", "app-too-old"],
  ["tokamak@0.1.2-rc..1", "other-line"],
  ["tokamak@0.1.2-01", "other-line"],
  ["tokamak@0.1.3", "app-too-old"],
  ["0.2.0", "newer-line"],
  ["0.0.9", "older-line"],
  ["1.1.0", "newer-line"],
  ["tokamak@^0.1", "fits"],
  ["tokamak@0.1.broken", "other-line"],
])("app 0.1.2 compares %s as %s", (build, result) => {
  expect(compatibility("0.1.2", build)).toBe(result);
});
