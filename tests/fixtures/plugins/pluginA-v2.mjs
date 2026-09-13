export default { name: "plugin-a", version: "2.0.0", description: "Test plugin A, reloaded with a renamed tool" };

export const tools = [
  {
    name: "plugin_a_tool_v2",
    description: "The renamed tool from plugin A's second version.",
    version: "2.0.0",
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    jsonSchema: { type: "object", properties: {} },
    requiredPermissions: [],
    requiresApproval: false,
    async execute() {
      return { output: { from: "plugin-a-v2" } };
    },
  },
];
