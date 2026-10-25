<script setup lang="ts">
// A Lucide icon from design/examples/icons.js (stroke 1.75), rendered on the server too.
import { computed } from "vue";
import { ICONS } from "../rk-icons";

const props = defineProps<{ name: string; size?: number }>();
const body = computed(() => ICONS[props.name] ?? "");
</script>

<template>
  <svg
    class="ic"
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="body"
  />
</template>
