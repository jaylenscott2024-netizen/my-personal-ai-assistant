export default { name: "plugin-b", version: "1.0.0", description: "Test plugin B" };

export const tools = [
  {
    name: "plugin_b_tool",
    description: "A tool from plugin B.",
    version: "1.0.0",
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    jsonSchema: { type: "object", properties: {} },
    requiredPermissions: [],
    requiresApproval: false,
    async execute() {
      return { output: { from: "plugin-b" } };
    },
  },
];
