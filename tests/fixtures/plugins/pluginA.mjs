export default { name: "plugin-a", version: "1.0.0", description: "Test plugin A" };

export const tools = [
  {
    name: "plugin_a_tool",
    description: "A tool from plugin A.",
    version: "1.0.0",
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    jsonSchema: { type: "object", properties: {} },
    requiredPermissions: [],
    requiresApproval: false,
    async execute() {
      return { output: { from: "plugin-a" } };
    },
  },
];
