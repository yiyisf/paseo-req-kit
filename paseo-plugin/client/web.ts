// The only file that uses web-only things (Paseo's rule for plugins): the prototype review page
// shown inside Paseo, in an iframe, on the web app and the desktop app. Phones get null and
// the screen offers a link instead.
import { createElement, type ReactElement } from "react";
import { Platform } from "react-native";

export const canEmbedPages = Platform.OS === "web";

export function embeddedPage(url: string, title: string): ReactElement | null {
  if (Platform.OS !== "web") return null;
  return createElement("iframe" as string, {
    src: url,
    title,
    allow: "clipboard-read; clipboard-write",
    style: { border: 0, width: "100%", height: "calc(100vh - 120px)", minHeight: 560, display: "block", background: "transparent" },
  } as Record<string, unknown>);
}
