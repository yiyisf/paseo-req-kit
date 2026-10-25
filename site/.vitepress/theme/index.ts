import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import RkHome from "./components/RkHome.vue";
import "./rk-tokens.css";
import "./rk.css";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-before": () => h(RkHome),
    }),
} satisfies Theme;
