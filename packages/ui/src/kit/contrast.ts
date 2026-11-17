function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const probe = typeof document === "undefined" ? undefined : document.createElement("canvas").getContext("2d");

// Reads a token as the browser resolved it, as #rrggbb.
export function tokenHex(element: Element, name: string): string {
  const value = getComputedStyle(element).getPropertyValue(`--color-${name}`).trim();
  if (!probe) return value;
  probe.fillStyle = "#000";
  probe.fillStyle = value;
  return String(probe.fillStyle);
}

function channels(color: string): number[] {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (match)
    return match[1]!
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).concat(1);
}

// Contrast of a translucent token painted over an opaque one.
export function overContrast(element: Element, top: string, under: string): number {
  const read = (name: string) => getComputedStyle(element).getPropertyValue(`--color-${name}`).trim();
  const [r, g, b, a = 1] = channels(read(top));
  const base = channels(tokenHex(element, under));
  const mixed = [r!, g!, b!].map((v, i) => Math.round(v * a + base[i]! * (1 - a)));
  const hex = (values: number[]) => "#" + values.map((v) => v.toString(16).padStart(2, "0")).join("");
  return contrast(hex(mixed), hex(base.slice(0, 3)));
}
