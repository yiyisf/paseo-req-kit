import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import HomeExtras from "./components/HomeExtras.vue";
import PaseoSimWindow from "./components/PaseoSimWindow.vue";
import PipelineFlow from "./components/PipelineFlow.vue";
import ProblemCompare from "./components/ProblemCompare.vue";
import PhaseModeCard from "./components/PhaseModeCard.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-features-after": () => h(HomeExtras),
    }),
  enhanceApp({ app }) {
    app.component("PaseoSimWindow", PaseoSimWindow);
    app.component("PipelineFlow", PipelineFlow);
    app.component("ProblemCompare", ProblemCompare);
    app.component("PhaseModeCard", PhaseModeCard);
  },
} satisfies Theme;
