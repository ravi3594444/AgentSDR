import type { Metadata } from "next";
import { connection } from "next/server";
import { Instrument_Serif } from "next/font/google";
import AppShell from "@/components/AppShell";
import DialogProvider from "@/components/DialogProvider";
import { DemoProvider } from "@/components/demo/DemoProvider";
import { brandDisplay } from "@/components/brand/font";
import { THEME_INIT_SCRIPT, ThemeProvider } from "@/components/theme/ThemeProvider";
import { isDemoMode } from "@/lib/demo/mode";
import "./globals.css";
import { BRAND } from "@/lib/brand";

const fontSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif-next",
});

export const metadata: Metadata = {
  // Pages name themselves ("Leads"); the brand follows, as in the section layouts.
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  applicationName: BRAND.name,
  // A private workspace behind sign-in: keep every page out of search.
  robots: { index: false, follow: false },
  description: BRAND.description,
  // The favicon is src/app/icon.svg and apple-icon.tsx (Next's file convention):
  // the brand tile, which reads on light and dark tabs alike.
};

export default async function RootLayout({
  children,
  modal,
}: Readonly<{
  children: React.ReactNode;
  /** Pop-ups with their own URL — today only Settings (src/app/@modal). */
  modal: React.ReactNode;
}>) {
  // DEMO_MODE is a runtime setting of the deployment, not of the build: read
  // it per request, never baked into a prerendered page.
  await connection();
  const demo = isDemoMode();

  // Theme: data-theme="light" is the server default. THEME_INIT_SCRIPT runs
  // before paint and switches <html> to the stored choice (light, dark, or the
  // OS preference) — the `.dark` token block in globals.css does the rest —
  // and ThemeProvider keeps it in sync after hydration. data-theme also stops
  // the OS-preference dark block from applying on its own.
  //
  // suppressHydrationWarning: that script, and the call-recorder extension
  // (data-agentsdr-recorder, RECORDER_INSTALLED_ATTRIBUTE in
  // src/lib/calls/contract.ts), change <html> attributes before React loads.
  // It covers this element's own attributes only, not its children.
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${fontSerif.variable} ${brandDisplay.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-bg-white-0 text-text-strong-950">
        <ThemeProvider>
          <DialogProvider>
            <DemoProvider enabled={demo}>
              <AppShell>{children}</AppShell>
              {modal}
            </DemoProvider>
          </DialogProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
