function luminance([r, g, b]: number[]): number {
  const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function ratio(a: number[], b: number[]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const canvas = typeof document === "undefined" ? undefined : document.createElement("canvas");
const paint = canvas?.getContext("2d", { willReadFrequently: true });

// Paints `under`, then `over` on top, and reads back the pixel the browser drew.
function painted(element: Element, under: string, over?: string): number[] {
  const read = (name: string) => getComputedStyle(element).getPropertyValue(`--color-${name}`).trim();
  if (!paint) return [0, 0, 0];
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = read(under);
  paint.fillRect(0, 0, 1, 1);
  if (over) {
    paint.fillStyle = read(over);
    paint.fillRect(0, 0, 1, 1);
  }
  return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

// Contrast of token `top` drawn over token `under`, as painted in this element.
export function tokenContrast(element: Element, top: string, under: string): number {
  return ratio(painted(element, under, top), painted(element, under));
}
