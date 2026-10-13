import QRCode from "qrcode";

/**
 * Рисуем QR в SVG и отдаём data-URI: UI просто ставит `<img src=...>`,
 * никаких дополнительных библиотек на стороне интерфейса.
 */
export async function qrDataUrl(text: string): Promise<string | null> {
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "L" });
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  } catch {
    return null;
  }
}

/** ASCII-QR для консоли. */
export async function qrTerminal(text: string): Promise<string> {
  try {
    return await QRCode.toString(text, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  } catch {
    return text;
  }
}
