import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./access.css";
import "leaflet/dist/leaflet.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "127.0.0.1:3000";
  const imageUrl = `${protocol}://${host}/og.png`;
  return {
    title: "راهکار | سامانه مدیریت عملیات میدانی",
    description: "سامانه مدیریت مأموریت، فعالیت و گزارش‌های نیروهای میدانی",
    manifest: "/manifest.webmanifest",
    icons: { icon: "/icon.svg", apple: "/icon.svg" },
    openGraph: {
      title: "راهکار | سامانه مدیریت عملیات میدانی",
      description: "اپ کارمند و پنل مدیریت عملیات میدانی راهکار",
      locale: "fa_IR",
      type: "website",
      images: [{ url: imageUrl, width: 1736, height: 909, alt: "نمای اپ کارمند و پنل مدیریت راهکار" }],
    },
    twitter: { card: "summary_large_image", images: [imageUrl] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fa" dir="rtl"><body>{children}</body></html>;
}
