import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

/**
 * The Apple touch icon: the app tile from components/brand/Logo.tsx with
 * BRAND.monogram, rendered to PNG at build time (it reads nothing per
 * request). src/app/icon.svg is the same tile; change them together.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000000",
          color: "#ffffff",
          fontSize: 72,
          fontWeight: 800,
          letterSpacing: -3,
        }}
      >
        {BRAND.monogram}
      </div>
    ),
    size,
  );
}
