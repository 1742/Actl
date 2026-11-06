import { ref } from "vue";

// Shared by the list sidebar and detail views so a sidebar refresh updates both.
export const skillsRefreshVersion = ref(0);
export const mcpRefreshVersion = ref(0);
